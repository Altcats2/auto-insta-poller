const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`PASS  ${name}`);
  passed++;
}
let clock;

async function scenario(run, { autoAnswer = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="modals-container"></div></body>', {
    url: 'https://tower.la.utexas.edu/app_home/dashboard', runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(), // keep content.js's progress logs out of the output
  });
  const { window } = dom;
  const { document } = window;
  clock = require('./fake-clock')(window);
  const clicks = [];
  window.chrome = {
    runtime: { sendMessage: (_msg, cb) => cb && cb(), lastError: null },
    storage: {
      sync: { get: (defaults, cb) => cb({ ...defaults, sound: false, flashTitle: false, autoAnswer }) },
      onChanged: { addListener: () => {} },
    },
  };
  const container = document.createElement('div');
  container.className = 'vm--container';
  container.innerHTML = `<div data-modal="poll_42" aria-expanded="true"></div>
    <div class="vm--modal"><button class="close" aria-label="Close">×</button><div class="modal-body">
      <p class="mathjax-convert">Question</p>
      <div><button type="button" class="btn-primary">A</button><span class="mathjax-convert">First</span></div>
    </div><div class="modal-footer"><button>Submit answer</button></div></div>`;
  const [close, first, submit] = container.querySelectorAll('button');
  close.onclick = () => clicks.push('poll-closed');
  first.onclick = () => clicks.push('first');
  submit.onclick = () => clicks.push('submit');

  // A SweetAlert2-style popup, appended to <body> like the real library does.
  // Older releases render every icon and hide the unused ones.
  function swal(icon = 'success') {
    const el = document.createElement('div');
    el.className = 'swal2-container';
    const icons = ['error', 'warning', 'info', 'success'].map(name =>
      `<div class="swal2-icon swal2-${name}"${name === icon ? '' : ' style="display: none;"'}></div>`).join('');
    el.innerHTML = `<div class="swal2-popup">${icons}
      <button type="button" class="swal2-confirm swal2-styled">OK</button>
      <button type="button" class="swal2-cancel swal2-styled" style="display: none;">Cancel</button></div>`;
    el.querySelector('.swal2-confirm').onclick = () => { clicks.push('swal-ok'); el.remove(); };
    el.querySelector('.swal2-cancel').onclick = () => clicks.push('swal-cancel');
    document.body.append(el);
    return el;
  }
  // A vue-js-modal confirmation, mounted in #modals-container like the poll.
  function vueModal(label = 'OK') {
    const el = document.createElement('div');
    el.className = 'vm--container';
    el.innerHTML = `<div data-modal="confirm"></div><div class="vm--modal">
      <p>Response recorded</p><button>Retry</button><button>${label}</button></div>`;
    const [retry, ok] = el.querySelectorAll('button');
    retry.onclick = () => clicks.push('retry');
    ok.onclick = () => { clicks.push(`modal-${label}`); el.remove(); };
    document.getElementById('modals-container').append(el);
    return el;
  }
  function start() {
    document.getElementById('modals-container').append(container);
    window.eval(source);
  }
  try { await run({ window, document, container, first, submit, swal, vueModal, start, clicks }); }
  finally { window.close(); }
}

(async () => {
  await scenario(async ({ start, swal, clicks }) => {
    start();
    await clock.advance(1500);
    check('submits before anything is dismissed', clicks, ['first', 'submit']);
    swal();
    await clock.advance(299);
    check('waits for the popup to finish opening', clicks, ['first', 'submit']);
    await clock.advance(1);
    check('confirms a SweetAlert after the automatic submit', clicks, ['first', 'submit', 'swal-ok']);
  });
  await scenario(async ({ start, vueModal, clicks }) => {
    start();
    await clock.advance(1500);
    vueModal('Done');
    await clock.advance(300);
    check('leaves other dialogs open', clicks, ['first', 'submit']);
  });
  await scenario(async ({ start, swal, clicks }) => {
    start();
    await clock.advance(1500);
    swal('error');
    await clock.advance(1000);
    check('leaves an error popup on screen', clicks, ['first', 'submit']);
  });
  await scenario(async ({ start, swal, clicks }) => {
    start();
    await clock.advance(1500);
    const popup = swal('warning');
    await clock.advance(1000);
    check('leaves a warning popup on screen', clicks, ['first', 'submit']);
    popup.remove();
  });
  await scenario(async ({ start, swal, clicks }) => {
    start();
    await clock.advance(1500 + 15000);
    swal();
    await clock.advance(1000);
    check('does not dismiss once the 15-second window has passed', clicks, ['first', 'submit']);
  });
  await scenario(async ({ start, submit, swal, clicks }) => {
    submit.remove(); // One-click poll: the option itself submits.
    start();
    await clock.advance(1500);
    swal();
    await clock.advance(1000);
    check('dismisses after a poll that submits on the option click', clicks, ['first', 'swal-ok']);
  });
  await scenario(async ({ start, submit, container, clicks }) => {
    submit.disabled = true; // Two-step poll still waiting on its Submit button.
    start();
    await clock.advance(1500);
    container.querySelector('.modal-body').append(container.ownerDocument.createElement('p'));
    await clock.advance(1000);
    check('never closes the poll modal while it waits for Submit', clicks, ['first']);
    submit.disabled = false;
    await clock.advance(0);
    check('the poll can still be submitted afterwards', clicks, ['first', 'submit']);
  });
  await scenario(async ({ document, start, swal, clicks }) => {
    const outside = document.createElement('button');
    outside.textContent = 'Submit';
    document.body.append(outside);
    start();
    outside.click();
    swal();
    await clock.advance(1000); // Still inside the 1.5 s selection delay.
    check('a Submit button outside a poll does not arm dismissal', clicks, []);
  });
  await scenario(async ({ start, submit, swal, clicks }) => {
    start();
    await clock.advance(1500);
    submit.click(); // The student submits by hand.
    swal();
    await clock.advance(1000);
    check('does not dismiss anything with automatic answering off', clicks, ['submit']);
  }, { autoAnswer: false });
  console.log(`\n${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
