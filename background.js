/*
 * Service worker: raises the actual OS notification.
 *
 * This lives outside the page so an alert still fires when the Tower tab is
 * backgrounded, the window is minimised, or the student is in another app --
 * which is the whole point, since Tower itself only renders a modal in a tab you
 * may not be looking at.
 *
 * MV3 workers are evicted aggressively, so per-poll state goes in
 * chrome.storage.session rather than a module-level Map.
 */

const NOTIF_PREFIX = 'tower-poll-';
const TEST_PREFIX = 'tower-test-';
const DEFAULTS = {
  autoAnswer: true,
  notify: true,
  sound: true,
  flashTitle: true,
  requireInteraction: true,
  focusTab: false,
};

const notifId = (pollId) => `${NOTIF_PREFIX}${pollId}`;

function create(id, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(id, options, () => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      resolve();
    });
  });
}

function update(id, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.update(id, options, () => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      resolve();
    });
  });
}

async function getOptions() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function bumpBadge() {
  const { pending = 0 } = await chrome.storage.session.get({ pending: 0 });
  const next = pending + 1;
  await chrome.storage.session.set({ pending: next });
  await chrome.action.setBadgeBackgroundColor({ color: '#BF5700' });
  await chrome.action.setBadgeText({ text: String(next) });
}

async function clearBadge() {
  await chrome.storage.session.set({ pending: 0 });
  await chrome.action.setBadgeText({ text: '' });
}

async function onPoll(msg, sender) {
  const key = `poll:${msg.id}`;
  const stored = await chrome.storage.session.get(key);
  if (stored[key]) return; // already announced by another frame or detector
  await chrome.storage.session.set({
    [key]: { tabId: sender.tab?.id, windowId: sender.tab?.windowId, at: Date.now() },
  });

  const opts = await getOptions();
  await bumpBadge();
  if (!opts.notify) return;

  await create(notifId(msg.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Instapoll posted',
    message: 'A new instapoll just appeared in Tower. Open the tab to answer it.',
    priority: 2,
    requireInteraction: !!opts.requireInteraction,
  });

  if (opts.focusTab && sender.tab?.id !== undefined) {
    try {
      await chrome.tabs.update(sender.tab.id, { active: true });
      if (sender.tab.windowId !== undefined) {
        await chrome.windows.update(sender.tab.windowId, { focused: true });
      }
    } catch (_) {}
  }
}

async function onPollText(msg) {
  const opts = await getOptions();
  if (!opts.notify) return;
  const choices = Array.isArray(msg.choices) && msg.choices.length
    ? `\n\nOptions: ${msg.choices.join('  \u2022  ')}`
    : '';
  // Replaces the placeholder body once the modal has actually rendered.
  await update(notifId(msg.id), {
    title: 'Instapoll posted',
    message: `${msg.prompt}${choices}`.slice(0, 900),
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const done = () => sendResponse({ ok: true });
  const failed = (error) => sendResponse({ ok: false, error: error.message || String(error) });
  if (msg.type === 'poll') onPoll(msg, sender).then(done, failed);
  else if (msg.type === 'pollText') onPollText(msg).then(done, failed);
  else if (msg.type === 'test') onTest().then(done, failed);
  else return;
  return true; // async sendResponse
});

async function focusPoll(notificationId) {
  if (notificationId.startsWith(TEST_PREFIX)) {
    chrome.notifications.clear(notificationId);
    return;
  }
  if (!notificationId.startsWith(NOTIF_PREFIX)) return;
  const key = `poll:${notificationId.slice(NOTIF_PREFIX.length)}`;
  const stored = await chrome.storage.session.get(key);
  const info = stored[key];
  chrome.notifications.clear(notificationId);
  await clearBadge();
  if (!info || info.tabId === undefined) return;
  try {
    await chrome.tabs.update(info.tabId, { active: true });
    if (info.windowId !== undefined) {
      await chrome.windows.update(info.windowId, { focused: true });
    }
  } catch (_) { /* tab is gone */ }
}

async function onTest() {
  const permission = await new Promise((resolve, reject) => {
    chrome.notifications.getPermissionLevel((level) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(level);
    });
  });
  if (permission !== 'granted') {
    throw new Error('Notifications are blocked. Enable notifications for this browser or extension.');
  }
  const opts = await getOptions();
  // A fresh ID avoids repeatedly clearing/recreating the same notification.
  await create(`${TEST_PREFIX}${crypto.randomUUID()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Tower test alert',
    message: 'This is a test alert. A real one shows the poll question here.',
    priority: 2,
    requireInteraction: !!opts.requireInteraction,
  });
}

chrome.notifications.onClicked.addListener(focusPoll);

chrome.action.onClicked.addListener(() => {
  clearBadge();
  chrome.runtime.openOptionsPage();
});
