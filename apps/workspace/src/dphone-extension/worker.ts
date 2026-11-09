import { browser } from './chrome.js';

let opening: Promise<void> | undefined;

async function openPhone() {
  const url = browser.runtime.getURL('extension.html');
  const [current] = await browser.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [url],
  });
  if (current) {
    const tab = await browser.tabs.update(current.tabId, { active: true }).catch(() => undefined);
    if (tab) {
      await browser.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  await browser.tabs.create({ url });
}

browser.action.onClicked.addListener(() => {
  opening ??= openPhone()
    .catch(() => console.warn('D-Phone could not open its phone tab'))
    .finally(() => {
      opening = undefined;
    });
});
