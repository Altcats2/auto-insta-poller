const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`PASS  ${name}`);
  passed++;
}

function background() {
  const state = { created: [], cleared: [], session: {}, badgeWrites: 0, permission: 'granted', error: null };
  const chrome = {
    runtime: {
      lastError: null,
      getURL: file => `chrome-extension://test/${file}`,
      onMessage: { addListener: listener => { state.message = listener; } },
    },
    notifications: {
      getPermissionLevel: cb => cb(state.permission),
      create: (id, options, cb) => {
        state.created.push({ id, options });
        chrome.runtime.lastError = state.error && { message: state.error };
        cb(id);
        chrome.runtime.lastError = null;
      },
      clear: id => { state.cleared.push(id); },
      onClicked: { addListener: listener => { state.click = listener; } },
    },
    storage: {
      sync: { get: async defaults => defaults },
      session: {
        get: async key => typeof key === 'string' ? { [key]: state.session[key] } : { ...key, ...state.session },
        set: async values => Object.assign(state.session, values),
      },
    },
    action: {
      setBadgeText: async () => { state.badgeWrites++; },
      setBadgeBackgroundColor: async () => {},
      onClicked: { addListener: () => {} },
    },
  };
  vm.runInNewContext(read('background.js'), { chrome, crypto: { randomUUID } });
  state.send = msg => new Promise(resolve => state.message(msg, {}, resolve));
  return state;
}

function options() {
  const dom = new JSDOM(read('options.html'), { runScripts: 'outside-only' });
  const { window } = dom;
  const state = { dom, requests: [], timers: [], saved: [] };
  window.setTimeout = (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; };
  window.clearTimeout = () => {};
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        if (state.throwError) throw new Error(state.throwError);
        state.requests.push(msg);
        state.reply = cb;
      },
    },
    storage: {
      sync: {
        get: (defaults, cb) => cb(defaults),
        set: (values, cb) => { state.saved.push(values); cb && cb(); },
      },
    },
  };
  window.eval(read('options.js'));
  state.box = id => window.document.getElementById(id);
  state.button = window.document.getElementById('test');
  state.status = window.document.getElementById('status');
  return state;
}

(async () => {
  const bg = background();
  check('test reports browser acceptance', (await bg.send({ type: 'test' })).ok, true);
  await bg.send({ type: 'test' });
  check('repeated tests use distinct notification IDs', new Set(bg.created.map(n => n.id)).size, 2);
  check('test IDs are separate from poll IDs', bg.created.every(n => n.id.startsWith('tower-test-')), true);
  await bg.click(bg.created[0].id);
  check('clicking a test dismisses it', bg.cleared, [bg.created[0].id]);
  check('clicking a test does not clear the poll badge', bg.badgeWrites, 0);

  bg.error = 'Notification service unavailable';
  const failed = await bg.send({ type: 'test' });
  check('notification creation failures are returned', failed.ok, false);
  check('notification errors retain their explanation', failed.error, bg.error);
  bg.error = null;
  check('a subsequent test can recover', (await bg.send({ type: 'test' })).ok, true);
  bg.permission = 'denied';
  const before = bg.created.length;
  check('denied permission is reported', (await bg.send({ type: 'test' })).ok, false);
  check('denied permission prevents a create attempt', bg.created.length, before);

  const polls = background();
  check('real poll notifications still succeed', (await polls.send({ type: 'poll', id: '42' })).ok, true);
  check('real polls keep stable notification IDs', polls.created[0].id, 'tower-poll-42');

  const ui = options();
  try {
    check('automatic answering is on by default', ui.box('autoAnswer').checked, true);
    ui.box('autoAnswer').checked = false;
    ui.box('autoAnswer').dispatchEvent(new ui.dom.window.Event('change'));
    check('turning automatic answering off is saved', { ...ui.saved.at(-1) }, { autoAnswer: false });
    ui.box('autoAnswer').checked = true;
    ui.box('autoAnswer').dispatchEvent(new ui.dom.window.Event('change'));
    check('turning it back on is saved', { ...ui.saved.at(-1) }, { autoAnswer: true });

    ui.button.click();
    ui.button.click();
    check('rapid clicks send only one request', ui.requests.length, 1);
    check('button is disabled while waiting for the worker', ui.button.disabled, true);
    ui.reply({ ok: true });
    check('success describes browser acceptance, not guaranteed display', ui.status.textContent.includes('Browser accepted'), true);
    check('button stays disabled during cooldown', ui.button.disabled, true);
    check('cooldown lasts five seconds', ui.timers.at(-1).ms, 5000);
    ui.timers.at(-1).fn();
    ui.button.click();
    check('button sends again after cooldown', ui.requests.length, 2);
    ui.reply({ ok: false, error: 'Notifications are blocked' });
    check('worker failure is visible in settings', ui.status.textContent, 'Notifications are blocked');
    ui.timers.at(-1).fn();
    ui.button.click();
    ui.dom.window.chrome.runtime.lastError = { message: 'Worker unavailable' };
    ui.reply();
    check('message transport failure is visible', ui.status.textContent.includes('Worker unavailable'), true);
    ui.dom.window.chrome.runtime.lastError = null;
    ui.timers.at(-1).fn();
    ui.throwError = 'Extension context invalidated';
    ui.button.click();
    check('synchronous message failure is visible', ui.status.textContent.includes('Extension context invalidated'), true);
    ui.timers.at(-1).fn();
    check('button recovers after an error', ui.button.disabled, false);
  } finally {
    ui.dom.window.close();
  }
  console.log(`\n${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
