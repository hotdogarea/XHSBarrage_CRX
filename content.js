(() => {
    "use strict";

    if (window.__ZEELIVE_XHS_EXTENSION_RUNNING__) {
        console.log("[ZeeLive-XHS] 插件脚本已在运行，跳过重复注入");
        return;
    }
    window.__ZEELIVE_XHS_EXTENSION_RUNNING__ = true;

    const WS_URL = "ws://127.0.0.1:8890";
    const PLATFORM = "xiaohongshu";
    const OBSERVER_CONFIG = { childList: true, subtree: true, characterData: true };
    const CONTAINER_SELECTORS = ["body"];
    const MESSAGE_SELECTORS = [".msg-item.role-user", ".folded-interaction-bar.role-user", ".comment-item", ".comment-list-item", "[class*='comment-item']", "[class*='comment-list-item']", "[class*='message']", "[class*='chat']"];
    const ENTER_SELECTORS = [".folded-interaction-bar.role-user", "[class*='folded-interaction']"];
    const BLOCK_TEXT_PATTERNS = [/在线观众/, /直播介绍/, /欢迎来到直播间/, /平台倡导/, /严禁/, /举报/, /通知/, /paintTiming/, /^Error$/i];
    const seenMessages = new Map();
    const semanticSeenMessages = new Map();

    let socket = null;
    let observer = null;
    let targetNode = null;
    let reconnectTimer = null;
    let observeTimer = null;
    let lastContainerLogTime = 0;
    let enabled = true;
    let pendingPayloads = [];
    let lastImHookPayloadTime = 0;
    const userIdByNickname = new Map();

    function log(message, data) {
        if (data !== undefined) {
            console.log(`[ZeeLive-XHS] ${message}`, data);
        } else {
            console.log(`[ZeeLive-XHS] ${message}`);
        }
    }

    function loadSettings(callback) {
        if (!chrome || !chrome.storage || !chrome.storage.sync) {
            callback();
            return;
        }
        chrome.storage.sync.get({ enabled: false }, (items) => {
            enabled = items.enabled !== false;
            callback();
        });
    }

    function notifyPopup(payload) {
        try {
            chrome.runtime.sendMessage({ type: "xhs_danmu_event", payload });
        } catch (error) {
            // popup 未打开时忽略
        }
    }

    function normalizeNicknameKey(nickname) {
        return String(nickname || "").replace(/\s+/g, " ").trim();
    }

    function enrichUserId(payload) {
        if (!payload || !payload.nickname) {
            return payload;
        }
        const nicknameKey = normalizeNicknameKey(payload.nickname);
        if (payload.user_id) {
            userIdByNickname.set(nicknameKey, payload.user_id);
            return payload;
        }
        const cachedUserId = userIdByNickname.get(nicknameKey);
        if (cachedUserId) {
            return Object.assign({}, payload, { user_id: cachedUserId });
        }
        return payload;
    }

    function injectPageHook() {
        chrome.runtime.sendMessage({ type: "inject_im_hook" }, (response) => {
            if (chrome.runtime.lastError || !response || !response.ok) {
                log("IM Hook 注入失败", chrome.runtime.lastError || response);
            }
        });
    }

    function handleInjectedMessage(event) {
        if (event.source !== window || !event.data) {
            return;
        }
        if (event.data.source === "ZEELIVE_XHS_IM_HOOK_READY") {
            log("IM Hook 已注入");
            notifyPopup({
                platform: PLATFORM,
                source: "im_hook",
                type: "info",
                nickname: "system",
                user_id: "",
                content: "IM Hook 已注入",
                timestamp: Date.now() / 1000
            });
            return;
        }
        if (event.data.source === "ZEELIVE_XHS_IM_HOOK_DEBUG") {
            log("IM Hook 探测", event.data.payload);
            return;
        }
        if (event.data.source !== "ZEELIVE_XHS_IM_HOOK" || !event.data.payload) {
            return;
        }
        const payload = enrichUserId(event.data.payload);
        if (!payload.type || !payload.nickname && !payload.user_id) {
            return;
        }
        const dedupeKey = `im|${payload.type}|${payload.user_id || payload.nickname}|${payload.content || ""}`;
        if (!rememberRawMessage(dedupeKey, 3000)) {
            return;
        }
        if (!rememberSemanticPayload(payload, "im_hook", 5000)) {
            return;
        }
        lastImHookPayloadTime = Date.now();
        log("捕获 IM 弹幕", payload);
        sendPayload(payload);
    }

    function connectWebSocket() {
        if (!enabled) {
            log("插件捕获已关闭");
            return;
        }
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        socket = new WebSocket(WS_URL);
        socket.addEventListener("open", () => {
            log(`已连接本地接收器: ${WS_URL}`);
            sendPayload({
                platform: PLATFORM,
                source: "extension",
                type: "info",
                nickname: "system",
                user_id: "",
                content: "小红书 Chrome 插件已连接",
                timestamp: Date.now() / 1000
            });
            flushPendingPayloads();
        });

        socket.addEventListener("close", () => {
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connectWebSocket, 1500);
        });

        socket.addEventListener("error", (event) => {
            log("本地接收器未就绪，静默等待重连", event);
        });
    }

    function sendPayload(payload) {
        if (!enabled) {
            return;
        }
        payload = enrichUserId(payload);
        notifyPopup(payload);
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            pendingPayloads.push(payload);
            pendingPayloads = pendingPayloads.slice(-200);
            connectWebSocket();
            return;
        }
        socket.send(JSON.stringify(payload));
    }

    function shouldSuppressDomPayload(payload) {
        if (!payload || payload.source !== "dom") {
            return false;
        }
        return Date.now() - lastImHookPayloadTime < 10000;
    }

    function flushPendingPayloads() {
        if (!socket || socket.readyState !== WebSocket.OPEN || pendingPayloads.length === 0) {
            return;
        }
        const payloads = pendingPayloads;
        pendingPayloads = [];
        for (const payload of payloads) {
            socket.send(JSON.stringify(payload));
        }
    }

    function findContainer() {
        for (const selector of CONTAINER_SELECTORS) {
            const node = document.querySelector(selector);
            if (node) {
                return node;
            }
        }
        return null;
    }

    function isLikelyMessageNode(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE || !node.matches) {
            return false;
        }
        return MESSAGE_SELECTORS.some((selector) => node.matches(selector) || node.querySelector(selector));
    }

    function extractText(node, selectors) {
        for (const selector of selectors) {
            const element = node.querySelector(selector);
            if (element) {
                let text = element.textContent || "";
                const emojis = element.querySelectorAll("img.emoji-img, img[class*='emoji']");
                emojis.forEach((img) => {
                    const alt = img.getAttribute("alt") || "";
                    if (alt) {
                        text = text.replace(img.outerHTML, alt);
                    }
                });
                const trimmed = text.trim();
                if (trimmed) {
                    return trimmed;
                }
            }
        }
        return "";
    }

    function normalizeText(text) {
        return String(text || "").replace(/\s+/g, " ").trim();
    }

    function cleanupSemanticSeenMessages(now) {
        for (const [key, value] of semanticSeenMessages.entries()) {
            if (now - value.time > 30000) {
                semanticSeenMessages.delete(key);
            }
        }
    }

    function getSemanticKey(payload) {
        if (!payload) {
            return "";
        }
        const type = normalizeText(payload.type);
        const nickname = normalizeText(payload.nickname);
        const userId = normalizeText(payload.user_id);
        const content = normalizeText(payload.content);
        if (!type || !nickname) {
            return "";
        }
        if (type === "enter") {
            return `${type}|${userId || nickname}`;
        }
        if (!content) {
            return "";
        }
        return `${type}|${nickname}|${content}`;
    }

    function rememberSemanticPayload(payload, source, ttl) {
        const key = getSemanticKey(payload);
        if (!key) {
            return true;
        }
        const now = Date.now();
        const lastSeen = semanticSeenMessages.get(key);
        cleanupSemanticSeenMessages(now);
        if (lastSeen && now - lastSeen.time < ttl) {
            return false;
        }
        semanticSeenMessages.set(key, { time: now, source, user_id: payload.user_id || "" });
        return true;
    }

    function hasRecentImSemanticPayload(payload, ttl) {
        const key = getSemanticKey(payload);
        if (!key) {
            return false;
        }
        const now = Date.now();
        const lastSeen = semanticSeenMessages.get(key);
        cleanupSemanticSeenMessages(now);
        return !!(lastSeen && lastSeen.source === "im_hook" && now - lastSeen.time < ttl);
    }

    function isBlockedText(text) {
        if (!text || text.length < 2 || text.length > 120) {
            return true;
        }
        return BLOCK_TEXT_PATTERNS.some((pattern) => pattern.test(text));
    }

    function classifyMessageType(content) {
        const cleanContent = normalizeText(content);
        if (/为主播点赞了|点赞了/.test(cleanContent)) {
            return "like";
        }
        if (/关注了主播|关注了/.test(cleanContent)) {
            return "follow";
        }
        return "comment";
    }

    function rememberMessage(nickname, content) {
        const now = Date.now();
        const dedupeKey = `${nickname}|${content}`;
        const lastSeen = seenMessages.get(dedupeKey) || 0;
        if (now - lastSeen < 3000) {
            return false;
        }
        seenMessages.set(dedupeKey, now);

        for (const [key, value] of seenMessages.entries()) {
            if (now - value > 30000) {
                seenMessages.delete(key);
            }
        }
        return true;
    }

    function rememberRawMessage(dedupeKey, ttl) {
        const now = Date.now();
        const lastSeen = seenMessages.get(dedupeKey) || 0;
        if (now - lastSeen < ttl) {
            return false;
        }
        seenMessages.set(dedupeKey, now);
        for (const [key, value] of seenMessages.entries()) {
            if (now - value > 30000) {
                seenMessages.delete(key);
            }
        }
        return true;
    }

    function createPayload(nickname, content, source) {
        const cleanNickname = normalizeText(nickname).replace(/[：:]+$/, "") || "这位家人";
        let cleanContent = normalizeText(content);
        const eventType = source.eventType || "comment";
        const userId = source.user_id || "";
        if (eventType === "enter") {
            cleanContent = "进入直播间";
        }

        if (eventType === "comment" || eventType === "like" || eventType === "follow") {
            if (isBlockedText(cleanContent) || cleanContent === cleanNickname) {
                return null;
            }
            if (!rememberMessage(cleanNickname, cleanContent)) {
                return null;
            }
        } else if (eventType === "enter") {
            if (!cleanNickname || cleanNickname === "这位家人") {
                return null;
            }
            const dedupeKey = `enter_${cleanNickname}`;
            const now = Date.now();
            const lastSeen = seenMessages.get(dedupeKey) || 0;
            if (now - lastSeen < 5000) {
                return null;
            }
            seenMessages.set(dedupeKey, now);
        }

        const now = Date.now();
        return {
            platform: PLATFORM,
            source: "dom",
            type: eventType,
            nickname: cleanNickname,
            user_id: userId,
            content: cleanContent,
            display_text: createDisplayText(eventType, cleanNickname, cleanContent),
            timestamp: now / 1000
        };
    }

    function createDisplayText(eventType, nickname, content) {
        const typeNameMap = {
            comment: "评论",
            enter: "进入",
            like: "点赞",
            follow: "关注"
        };
        const typeName = typeNameMap[eventType] || eventType;
        if (eventType === "enter") {
            return `[${typeName}] ${nickname} ${content}`;
        }
        return `[${typeName}] ${nickname}: ${content}`;
    }

    function extractUserId(node) {
        if (!node || !node.querySelectorAll) {
            return "";
        }
        const candidates = [node, ...Array.from(node.querySelectorAll("*"))];
        const attrNames = ["data-user-id", "data-userid", "user-id", "userid", "uid", "data-uid"];
        for (const element of candidates) {
            for (const attrName of attrNames) {
                const value = element.getAttribute && element.getAttribute(attrName);
                if (value) {
                    return normalizeText(value);
                }
            }
        }

        const link = candidates
            .filter((element) => element.tagName === "A" && element.href)
            .map((element) => element.href)
            .find((href) => /\/user\/profile\/|\/user\//.test(href));
        if (!link) {
            return "";
        }
        const match = link.match(/\/user\/(?:profile\/)?([^/?#]+)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    function extractMessage(node) {
        const isEnter = ENTER_SELECTORS.some((selector) => node.matches && node.matches(selector));
        const messageNode = MESSAGE_SELECTORS.some((selector) => node.matches && node.matches(selector))
            ? node
            : MESSAGE_SELECTORS.map((selector) => node.querySelector && node.querySelector(selector)).find(Boolean);

        if (!messageNode) {
            return null;
        }

        let nickname = "";
        let content = "";

        if (isEnter) {
            nickname = extractText(messageNode, [".folded-interaction-content .folded-interaction-nickname", "[class*='folded-interaction-nickname']"]);
            content = extractText(messageNode, [".folded-interaction-content .folded-interaction-text", "[class*='folded-interaction-text']"]);
            if (!content) {
                content = "进入直播间";
            }
        } else {
            nickname = extractText(messageNode, [".msg-content .nickname", "span.nickname", "[class*='nickname']", "[class*='name']"]);
            content = extractText(messageNode, [".msg-content .content", "span.content", "span.desc", "[class*='desc']", "[class*='content']", "[class*='text']"]);

            if (!nickname || !content) {
                const spans = Array.from(messageNode.querySelectorAll("span"))
                    .map((span) => normalizeText(span.textContent))
                    .filter(Boolean);

                if (!nickname && spans.length >= 2) {
                    nickname = spans[spans.length - 2].replace(/[：:]+$/, "");
                }
                if (!content && spans.length >= 1) {
                    content = spans[spans.length - 1];
                }
            }
        }
        const eventType = isEnter ? "enter" : classifyMessageType(content);

        return createPayload(nickname, content, {
            mode: "dom",
            html: messageNode.outerHTML.slice(0, 1000),
            eventType,
            user_id: extractUserId(messageNode)
        });
    }

    function handleMessageNode(node, logLabel) {
        if (!isLikelyMessageNode(node)) {
            return;
        }
        const payload = extractMessage(node);
        if (payload) {
            if (shouldSuppressDomPayload(payload)) {
                return;
            }
            setTimeout(() => {
                if (hasRecentImSemanticPayload(payload, 1500)) {
                    return;
                }
                if (!rememberSemanticPayload(payload, "dom", 5000)) {
                    return;
                }
                log(logLabel, payload);
                sendPayload(payload);
            }, 800);
        }
    }

    function startObserver(container) {
        if (observer) {
            observer.disconnect();
        }
        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes) {
                    for (const node of mutation.addedNodes) {
                        handleMessageNode(node, "捕获弹幕");
                    }
                }
                if (mutation.type === "characterData" || mutation.type === "childList") {
                    const target = mutation.target;
                    if (target) {
                        const enterBar = target.closest ? target.closest(".folded-interaction-bar.role-user") : null;
                        if (enterBar) {
                            handleMessageNode(enterBar, "捕获进房事件");
                        }
                    }
                }
            }
        });
        observer.observe(container, OBSERVER_CONFIG);
        log("已开始监听弹幕容器", container);
        return true;
    }

    function startObserveTimer() {
        if (observeTimer) {
            return;
        }
        observeTimer = setInterval(() => {
            if (!targetNode) {
                const container = findContainer();
                if (container) {
                    targetNode = container;
                    startObserver(container);
                } else {
                    const now = Date.now();
                    if (now - lastContainerLogTime > 5000) {
                        log("未找到弹幕容器，继续等待");
                        lastContainerLogTime = now;
                    }
                }
            }
        }, 2000);
    }

    function boot() {
        try {
            window.addEventListener("message", handleInjectedMessage);
            injectPageHook();
            connectWebSocket();
            clearInterval(observeTimer);
            const container = findContainer();
            if (container) {
                targetNode = container;
                startObserver(container);
            } else {
                log("未找到弹幕容器，开始定时查找");
                startObserveTimer();
            }
        } catch (error) {
            log("脚本启动错误", error);
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message && message.type === "get_status") {
            sendResponse({ enabled, wsUrl: WS_URL, location: window.location.href, running: true });
            return true;
        }
        if (message && message.type === "update_settings") {
            enabled = message.enabled !== false;
            if (socket) {
                socket.close();
                socket = null;
            }
            if (!enabled) {
                pendingPayloads = [];
            }
            if (enabled) {
                connectWebSocket();
            }
            sendResponse({ ok: true, enabled, wsUrl: WS_URL });
            return true;
        }
        return false;
    });

    loadSettings(() => {
        setTimeout(boot, 3000);
    });
})();
