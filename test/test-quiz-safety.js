const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
let clock;
const settle = () => clock.advance(1500);
let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`PASS  ${name}`);
  passed++;
}

async function scenario(firstDisabled, run) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://tower.la.utexas.edu/app_home/dashboard', runScripts: 'outside-only',
  });
  const { window } = dom;
  clock = require('./fake-clock')(window);
  const sent = [], posted = [], clicks = [];
  window.chrome = {
    runtime: { sendMessage: (msg, cb) => { sent.push(msg); cb && cb(); }, lastError: null },
    storage: {
      sync: { get: (defaults, cb) => cb({ ...defaults, sound: false, flashTitle: false }) },
      onChanged: { addListener: () => {} },
    },
  };
  window.XMLHttpRequest.prototype.open = function () {};
  window.XMLHttpRequest.prototype.send = function () {};
  window.fetch = () => Promise.resolve({});
  window.postMessage = data => posted.push(data);
  window.eval(read('hook.js'));
  window.eval(read('content.js'));
  const container = window.document.createElement('div');
  container.className = 'vm--container';
  container.innerHTML = `<div data-modal="poll_42"></div><div class="modal-body">
    <p class="mathjax-convert">Question</p>
    <div><button class="btn-primary" ${firstDisabled ? 'disabled' : ''}>A</button><span class="mathjax-convert">First</span></div>
    </div><div class="modal-footer"><button disabled>Submit answer</button></div>`;
  const first = container.querySelector('.btn-primary');
  const submit = container.querySelector('.modal-footer button');
  first.onclick = () => clicks.push('first');
  submit.onclick = () => clicks.push('submit');
  window.document.body.append(container);
  await settle();
  try { await run({ window, container, first, submit, sent, posted, clicks }); }
  finally { window.close(); }
}

(async () => {
  await scenario(true, async ({ window, container, first, submit, sent, posted, clicks }) => {
    check('dashboard poll is detected before navigation', sent.some(msg => msg.type === 'poll'), true);
    const count = sent.length;
    window.history.pushState({}, '', '/app_home/quiz?act_key=test-value#/');
    first.disabled = false;
    submit.disabled = false;
    window.dispatchEvent(new window.MessageEvent('message', {
      source: window,
      data: { __TOWER_INSTAPOLL_ALERT__: true, kind: 'poll', id: '99', source: 'xhr' },
    }));
    const second = container.cloneNode(true);
    second.querySelector('[data-modal]').setAttribute('data-modal', 'poll_100');
    window.document.body.append(second);
    const endpoint = '/log_endpoints/instapoll_activity_log.php';
    const body = JSON.stringify({ event_type: 'received', instapoll_id: 101 });
    const xhr = new window.XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.send(body);
    await window.fetch(endpoint, { method: 'POST', body });
    await settle();
    check('pending first-option and submit clicks stop on quiz navigation', clicks, []);
    check('new network and DOM poll events do not send alerts on quiz routes', sent.length, count);
    check('XHR and fetch hooks stop emitting on quiz routes', posted.length, 0);
  });
  await scenario(false, async ({ window, submit, clicks }) => {
    check('first choice is selected on the dashboard', clicks, ['first']);
    window.history.replaceState({}, '', '/app_home/quiz?act_key=other-test#/');
    submit.disabled = false;
    await settle();
    check('pending submission is canceled after navigation to a quiz', clicks, ['first']);
  });
  console.log(`\n${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
