'use strict';

const DEFAULTS = {
  autoAnswer: true,
  notify: true,
  sound: true,
  flashTitle: true,
  requireInteraction: true,
  focusTab: false,
};

const status = document.getElementById('status');
let statusTimer = null;

function flash(text, duration = 2000) {
  status.textContent = text;
  clearTimeout(statusTimer);
  if (duration) statusTimer = setTimeout(() => { status.textContent = ''; }, duration);
}

chrome.storage.sync.get(DEFAULTS, (values) => {
  for (const key of Object.keys(DEFAULTS)) {
    const box = document.getElementById(key);
    if (!box) continue;
    box.checked = !!values[key];
    box.addEventListener('change', () => {
      chrome.storage.sync.set({ [key]: box.checked }, () => flash('Saved'));
    });
  }
});

const testButton = document.getElementById('test');
testButton.addEventListener('click', () => {
  if (testButton.disabled) return;
  testButton.disabled = true;
  testButton.textContent = 'Sending…';
  flash('Sending test alert…', 0);
  const finish = (message) => {
    flash(message, 0);
    testButton.textContent = 'Wait 5 seconds…';
    setTimeout(() => {
      testButton.disabled = false;
      testButton.textContent = 'Send a test alert';
    }, 5000);
  };
  try {
    chrome.runtime.sendMessage({ type: 'test' }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) finish(`Could not reach the extension: ${error.message}`);
      else if (!response?.ok) finish(response?.error || 'The extension did not confirm the test alert.');
      else finish('Browser accepted the test. If no banner appears, check Windows notifications and Do not disturb.');
    });
  } catch (error) {
    finish(`Could not reach the extension: ${error.message}`);
  }
});
