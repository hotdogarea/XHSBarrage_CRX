const XHS_MATCHES = [
    "redlive.xiaohongshu.com",
    "ark.xiaohongshu.com",
    "www.xiaohongshu.com"
];

const captureBtn = document.getElementById("captureBtn");
const keyFilterBtn = document.getElementById("keyFilterBtn");
const pageStatus = document.getElementById("pageStatus");
const captureStatus = document.getElementById("captureStatus");
const logBox = document.getElementById("log");

let enabled = false;
const maxLogItems = 80;
let keyOnly = false;
let logItems = [];

function clearEmptyLog() {
    const empty = logBox.querySelector(".empty-log");
    if (empty) {
        empty.remove();
    }
}

function shouldShowPayload(payload) {
    if (!keyOnly) {
        return true;
    }
    return payload && (payload.type === "comment" || payload.type === "follow");
}

function updateFilterButton() {
    keyFilterBtn.textContent = keyOnly ? "显示全部弹幕" : "只看关键弹幕";
    keyFilterBtn.className = keyOnly ? "filter-btn active" : "filter-btn";
}

function appendTextLog(text) {
    appendDanmuLog({
        type: "info",
        nickname: "system",
        user_id: "",
        content: text
    });
}

function createDanmuElement(payload) {
    const time = new Date().toLocaleTimeString();
    const typeNameMap = {
        comment: "评论",
        enter: "进入",
        like: "点赞",
        follow: "关注",
        info: "信息"
    };
    const type = payload.type || "info";
    const typeName = typeNameMap[type] || type;
    const item = document.createElement("div");
    item.className = "danmu-item";
    const header = document.createElement("div");
    header.className = "danmu-header";
    const timeEl = document.createElement("span");
    timeEl.className = "danmu-time";
    timeEl.textContent = time;
    const typeEl = document.createElement("span");
    typeEl.className = `danmu-type ${type}`;
    typeEl.textContent = typeName;
    const nameEl = document.createElement("span");
    nameEl.className = "danmu-name";
    nameEl.textContent = payload.nickname || "这位家人";
    const uidEl = document.createElement("span");
    uidEl.className = "danmu-uid";
    uidEl.textContent = payload.user_id || "-";
    const contentEl = document.createElement("div");
    contentEl.className = "danmu-content";
    contentEl.textContent = payload.content || "";
    header.appendChild(timeEl);
    header.appendChild(typeEl);
    header.appendChild(nameEl);
    header.appendChild(uidEl);
    item.appendChild(header);
    item.appendChild(contentEl);
    return item;
}

function renderLogs() {
    logBox.innerHTML = "";
    const visibleItems = logItems.filter(shouldShowPayload).slice(0, maxLogItems);
    if (visibleItems.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-log";
        empty.textContent = keyOnly ? "暂无关键弹幕" : "暂无事件";
        logBox.appendChild(empty);
        return;
    }
    for (const payload of visibleItems) {
        logBox.appendChild(createDanmuElement(payload));
    }
    logBox.scrollTop = 0;
}

function appendDanmuLog(payload) {
    logItems.unshift(payload);
    logItems = logItems.slice(0, maxLogItems * 2);
    renderLogs();
    logBox.scrollTop = 0;
}

function isXhsLiveUrl(url) {
    try {
        const parsed = new URL(url);
        const isXhsHost = XHS_MATCHES.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
        return isXhsHost && (parsed.href.includes("/livestream/") || parsed.hostname !== "www.xiaohongshu.com");
    } catch (error) {
        return false;
    }
}

async function getLiveTab() {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTabs && activeTabs[0] && isXhsLiveUrl(activeTabs[0].url || "")) {
        return activeTabs[0];
    }

    const allTabs = await chrome.tabs.query({});
    return allTabs.find((tab) => isXhsLiveUrl(tab.url || "")) || null;
}

function updateButton() {
    captureStatus.textContent = enabled ? "运行中" : "未启动";
    captureBtn.textContent = enabled ? "停止捕获" : "开始捕获";
    captureBtn.className = enabled ? "running" : "stopped";
}

async function loadSettings() {
    const items = await chrome.storage.sync.get({ enabled: false });
    enabled = items.enabled === true;
    updateButton();
}

async function refreshStatus() {
    const tab = await getLiveTab();
    if (!tab || !tab.id) {
        pageStatus.textContent = "未找到小红书直播页";
        updateButton();
        return;
    }

    pageStatus.textContent = "小红书直播页";
    chrome.tabs.sendMessage(tab.id, { type: "get_status" }, (response) => {
        if (chrome.runtime.lastError || !response) {
            captureStatus.textContent = "页面待刷新";
            return;
        }
        enabled = response.enabled === true;
        updateButton();
    });
}

async function toggleCapture() {
    enabled = !enabled;
    await chrome.storage.sync.set({ enabled });
    updateButton();

    const tab = await getLiveTab();
    if (!tab || !tab.id) {
        pageStatus.textContent = "未找到小红书直播页";
        appendTextLog("请先打开小红书直播页");
        return;
    }

    chrome.tabs.sendMessage(tab.id, { type: "update_settings", enabled }, (response) => {
        if (chrome.runtime.lastError || !response) {
            if (enabled) {
                appendTextLog("已开始捕获，正在自动刷新直播页");
                chrome.tabs.reload(tab.id);
            } else {
                appendTextLog("已停止捕获");
            }
            return;
        }
        appendTextLog(enabled ? "已开始捕获" : "已停止捕获");
        if (enabled) {
            chrome.tabs.reload(tab.id);
        }
        refreshStatus();
    });
}

chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "xhs_danmu_event" || !message.payload) {
        return;
    }
    appendDanmuLog(message.payload);
});

captureBtn.addEventListener("click", toggleCapture);
keyFilterBtn.addEventListener("click", () => {
    keyOnly = !keyOnly;
    updateFilterButton();
    renderLogs();
});

loadSettings().then(refreshStatus);
updateFilterButton();
setInterval(refreshStatus, 3000);
