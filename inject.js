(() => {
    "use strict";

    if (window.__ZEELIVE_XHS_IM_HOOK__) {
        return;
    }
    window.__ZEELIVE_XHS_IM_HOOK__ = true;

    const ALLOWED_TYPES = new Map([
        ["text", "comment"],
        ["text_message", "comment"],
        ["audience_join_v2", "enter"],
        ["follow_emcee", "follow"],
        ["praise", "like"],
        ["combo_praise", "like"],
        ["light", "like"],
        ["like", "like"],
        ["live_like", "like"],
        ["like_comment", "like"],
        ["live_common_msg_action", "like"]
    ]);

    const seen = new Map();
    let parseHitCount = 0;
    let wsHitCount = 0;
    let decodeFailReported = false;

    function debug(stage, count) {
        if (count !== 1 && count !== 5 && count !== 20 && count !== 50) {
            return;
        }
        window.postMessage({
            source: "ZEELIVE_XHS_IM_HOOK_DEBUG",
            payload: { stage, count }
        }, "*");
    }

    function reportDecodeFail(customData) {
        if (decodeFailReported) {
            return;
        }
        decodeFailReported = true;
        window.postMessage({
            source: "ZEELIVE_XHS_IM_HOOK_DEBUG",
            payload: {
                stage: "custom_data_decode_failed",
                count: 1,
                dataType: typeof customData,
                sample: String(customData || "").slice(0, 80)
            }
        }, "*");
    }

    function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function getUserId(data, envelope) {
        const profile = data && data.profile ? data.profile : {};
        return normalizeText(profile.user_id || profile.userId || profile.id || (envelope && envelope.from) || "");
    }

    function getNickname(data) {
        const profile = data && data.profile ? data.profile : {};
        const direct = normalizeText(
            profile.nickname ||
            profile.nick_name ||
            profile.nickName ||
            profile.name ||
            profile.displayName ||
            profile.userName ||
            data.nickname ||
            data.nick_name ||
            data.nickName ||
            data.name ||
            data.userName ||
            data.username ||
            (data.user && (data.user.nickname || data.user.nick_name || data.user.nickName || data.user.name)) ||
            (data.operator && (data.operator.nickname || data.operator.nick_name || data.operator.nickName || data.operator.name)) ||
            (data.sender && (data.sender.nickname || data.sender.nick_name || data.sender.nickName || data.sender.name)) ||
            ""
        );
        if (direct) {
            return direct;
        }
        return findValueByKeys(data, ["nickname", "nick_name", "nickName", "userName", "username"], 3);
    }

    function getLikeNickname(data) {
        const text = normalizeText(data && (data.desc || data.msg || data.content || ""));
        if (!text) {
            return "";
        }
        const match = text.match(/^(.+?)(?:\s+)?(?:(?:为|给)主播)?(?:点亮|点赞|赞了|点了赞)/);
        if (!match || !match[1]) {
            return "";
        }
        return normalizeText(match[1].replace(/[：:，,。.!！]+$/, ""));
    }

    function findValueByKeys(value, keys, depth) {
        if (!value || typeof value !== "object" || depth < 0) {
            return "";
        }
        for (const key of keys) {
            const text = normalizeText(value[key]);
            if (text) {
                return text;
            }
        }
        for (const child of Object.values(value)) {
            const text = findValueByKeys(child, keys, depth - 1);
            if (text) {
                return text;
            }
        }
        return "";
    }

    function getContent(data, type) {
        if (!data) {
            return "";
        }
        const content = normalizeText(data.desc || data.msg || data.content || "");
        if (content && type !== "like") {
            return content;
        }
        if (type === "enter") {
            return "进入直播间";
        }
        if (type === "follow") {
            return "关注了主播";
        }
        if (type === "like") {
            return "点赞了";
        }
        return "";
    }

    function safeJsonParse(text) {
        try {
            return JSON.parse(text);
        } catch (error) {
            return null;
        }
    }

    function tryDecodeCustomData(customData) {
        if (!customData) {
            return null;
        }
        if (typeof customData === "object") {
            return customData;
        }
        const text = String(customData);
        const direct = safeJsonParse(text);
        if (direct) {
            return direct;
        }
        try {
            const decoded = decodeURIComponent(text);
            const parsed = safeJsonParse(decoded);
            if (parsed) {
                return parsed;
            }
        } catch (error) {}
        try {
            const decoded = atob(text);
            const parsed = safeJsonParse(decoded);
            if (parsed) {
                return parsed;
            }
        } catch (error) {}
        return null;
    }

    function inspectEnvelope(value) {
        const envelope = value && value.data && value.data.customData ? value.data : value;
        if (!envelope || !envelope.customData) {
            return;
        }
        const decoded = tryDecodeCustomData(envelope.customData);
        if (!decoded) {
            reportDecodeFail(envelope.customData);
            return;
        }
        if (decoded.type && decoded.profile) {
            emitIfUseful(decoded, envelope);
            return;
        }
        if (decoded.data && decoded.data.type && decoded.data.profile) {
            emitIfUseful(decoded.data, envelope);
        }
    }

    function emitIfUseful(data, envelope) {
        if (!data || typeof data !== "object") {
            return;
        }
        const rawType = data.type;
        let type = ALLOWED_TYPES.get(rawType);
        const rawContent = normalizeText(data.desc || data.msg || data.content || "");
        if (rawType === "live_common_msg_action" && !/点赞|praise|like/i.test(rawContent)) {
            return;
        }
        if (!type) {
            return;
        }
        const userId = getUserId(data, envelope);
        const nickname = (type === "like" ? getLikeNickname(data) : "") || getNickname(data) || (userId ? `用户${userId.slice(-6)}` : "");
        const content = getContent(data, type);
        if (!nickname && !userId) {
            return;
        }
        if (type === "comment" && !content) {
            return;
        }

        const key = `${type}|${userId}|${nickname}|${content}`;
        const now = Date.now();
        const lastSeen = seen.get(key) || 0;
        if (now - lastSeen < 3000) {
            return;
        }
        seen.set(key, now);
        for (const [itemKey, value] of seen.entries()) {
            if (now - value > 30000) {
                seen.delete(itemKey);
            }
        }

        window.postMessage({
            source: "ZEELIVE_XHS_IM_HOOK",
            payload: {
                platform: "xiaohongshu",
                source: "im_hook",
                type,
                nickname,
                user_id: userId,
                content,
                timestamp: now / 1000
            }
        }, "*");
    }

    function inspectParsedValue(value) {
        if (!value || typeof value !== "object") {
            return;
        }
        if ((value.command && value.customData) || (value.data && value.data.customData)) {
            parseHitCount += 1;
            debug("json_parse_candidate", parseHitCount);
            inspectEnvelope(value);
        }
        if (value.type && value.profile) {
            emitIfUseful(value, null);
            return;
        }
        if (value.data && value.data.type && value.data.profile) {
            emitIfUseful(value.data, value);
        }
    }

    const originalJsonParse = JSON.parse;
    JSON.parse = function patchedJsonParse(text, reviver) {
        const result = originalJsonParse.call(this, text, reviver);
        try {
            inspectParsedValue(result);
        } catch (error) {}
        return result;
    };

    const originalAddEventListener = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function patchedWsAddEventListener(type, listener, options) {
        if (type === "message" && typeof listener === "function") {
            const wrapped = function(event) {
                try {
                    wsHitCount += 1;
                    if (wsHitCount <= 5 || wsHitCount % 50 === 0) {
                        debug("websocket_message", wsHitCount);
                    }
                } catch (error) {}
                return listener.call(this, event);
            };
            return originalAddEventListener.call(this, type, wrapped, options);
        }
        return originalAddEventListener.call(this, type, listener, options);
    };

    window.postMessage({
        source: "ZEELIVE_XHS_IM_HOOK_READY"
    }, "*");
})();
