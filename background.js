chrome.action.onClicked.addListener(() => {
    chrome.windows.create({
        url: chrome.runtime.getURL("popup.html"),
        type: "popup",
        width: 560,
        height: 720,
        focused: true
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "inject_im_hook" || !sender.tab || !sender.tab.id) {
        return false;
    }

    chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        files: ["inject.js"],
        world: "MAIN"
    }).then(() => {
        sendResponse({ ok: true });
    }).catch((error) => {
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    });

    return true;
});
