/*
 * Behavioral coverage for the auto-answer switch: the stored value gates
 * selection, and flipping it acts on a poll that is already on screen.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`PASS  ${name}`);
  passed++;
}

// `defer` withholds the stored value so a poll can land before the read resolves,
// which is the real ordering: content.js runs at document_start.
async function scenario({ stored, defer = false }, run) {
  const dom = new JSDOM('<!doctype html><body><div id="modals-container"></div></body>', {
    url: 'https://tower.la.utexas.edu/app_home/dashboard', runScripts: 'outside-only',
  });
  const { window } = dom;
  const clock = require('./fake-clock')(window);
  window.Math.random = () => 0;
  const clicks = [];
  const listeners = [];
  let deliver = null;
  window.chrome = {
    runtime: { sendMessage: (_msg, cb) => cb && cb(), lastError: null },
    storage: {
      sync: {
        get: (defaults, cb) => {
          const values = { ...defaults, sound: false, flashTitle: false };
          if (!('autoAnswer' in defaults)) return cb(values);
          values.autoAnswer = stored;
          if (defer) deliver = () => cb(values);
          else cb(values);
        },
      },
      onChanged: { addListener: fn => listeners.push(fn) },
    },
  };
  window.eval(source);

  const settle = () => clock.advance(1500);
  // What the options page write looks like from inside the content script.
  const toggle = async (value) => {
    for (const fn of listeners) fn({ autoAnswer: { newValue: value } }, 'sync');
    await clock.advance(0);
  };
  const showPoll = (id) => {
    const container = window.document.createElement('div');
    container.className = 'vm--container';
    container.innerHTML = `<div class="vm--overlay" data-modal="poll_${id}" aria-expanded="true"></div>
      <div class="vm--modal"><div class="modal-body">
        <p class="mathjax-convert">Question</p>
        <div><button type="button" class="btn btn-primary"></button><span class="mathjax-convert">First</span></div>
        <div><button type="button" class="btn btn-primary"></button><span class="mathjax-convert">Second</span></div>
      </div></div>`;
    container.querySelectorAll('button').forEach((button, index) => {
      button.onclick = () => clicks.push(`${id}:${index}`);
    });
    window.document.getElementById('modals-container').append(container);
    return container;
  };

  try {
    await run({ window, clock, clicks, settle, toggle, showPoll, arrive: () => deliver && deliver() });
  } finally {
    window.close();
  }
}

(async () => {
  await scenario({ stored: false }, async ({ clicks, settle, toggle, showPoll }) => {
    showPoll('1');
    await settle();
    await settle();
    check('answers nothing while the switch is off', clicks, []);

    await toggle(true);
    check('switching on does not click before the delay', clicks, []);
    await settle();
    check('switching on answers the poll already on screen', clicks, ['1:0']);

    showPoll('2');
    await settle();
    check('a later poll is answered too', clicks, ['1:0', '2:0']);
  });

  await scenario({ stored: true }, async ({ clock, clicks, settle, toggle, showPoll }) => {
    showPoll('3');
    await clock.advance(1400);
    await toggle(false);
    await settle();
    await settle();
    check('switching off cancels a selection already counting down', clicks, []);

    await toggle(true);
    await settle();
    check('switching back on restarts the delay and answers', clicks, ['3:0']);

    await toggle(false);
    showPoll('4');
    await settle();
    check('a poll arriving while off is left alone', clicks, ['3:0']);
    await toggle(true);
    await settle();
    check('that poll is answered once the switch comes back on', clicks, ['3:0', '4:0']);
  });

  await scenario({ stored: false }, async ({ clicks, settle, showPoll, window }) => {
    const container = showPoll('5');
    container.remove();
    await settle();
    check('a closed modal is not answered when the switch is off', clicks, []);
    window.document.getElementById('modals-container').append(
      window.document.createElement('div') // force a mutation record so pruning runs
    );
    await settle();
    check('a closed modal stays unanswered', clicks, []);
  });

  await scenario({ stored: true, defer: true }, async ({ clicks, settle, showPoll, arrive }) => {
    showPoll('6');
    await settle();
    await settle();
    check('nothing is answered before the stored value arrives', clicks, []);
    arrive();
    await settle();
    check('the poll seen during startup is answered once the value arrives', clicks, ['6:0']);
  });

  await scenario({ stored: false, defer: true }, async ({ clicks, settle, showPoll, arrive }) => {
    showPoll('7');
    arrive();
    await settle();
    await settle();
    check('a stored off value keeps a startup poll unanswered', clicks, []);
  });

  console.log(`\n${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
