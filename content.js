// Content script — expose le texte sélectionné à l'extension

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_SELECTION") {
    const text = window.getSelection()?.toString().trim() || "";
    sendResponse({ text });
  }
  return false;
});
