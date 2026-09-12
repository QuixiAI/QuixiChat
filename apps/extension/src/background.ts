/// <reference path="./chrome.d.ts" />
/** The toolbar button opens the import page in a full tab; a popup would close
 * during a long transfer. No content script is injected without a user action
 * and an explicit origin grant on that page. */
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("import.html") });
});
