/*
 * Loads the real content.js into a jsdom page, then injects the exact DOM
 * vue-js-modal + StudentModalInstance produce (reconstructed from the render
 * functions in the deployed bundle) and asserts the detectors fire.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');
const contentSrc = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

const dom = new JSDOM(
  `<!doctype html><html><body><div id="dashboard_app"></div><div id="modals-container"></div></body></html>`,
  { url: 'https://tower.la.utexas.edu/app_home/dashboard', runScripts: 'outside-only', pretendToBeVisual: true }
);
const { window } = dom;

const sent = [];
window.chrome = {
  runtime: { sendMessage: (m, cb) => { sent.push(m); cb && cb(); }, lastError: null },
  storage: {
    sync: { get: (defaults, cb) => cb(defaults) },
    onChanged: { addListener: () => {} },
  },
};
window.AudioContext = undefined; // exercise the no-audio branch

window.eval(contentSrc);

// ---- the DOM vue-js-modal actually builds -----------------------------------
function showPoll(id, prompt, choices) {
  const container = window.document.createElement('div');
  container.className = 'vm--container scrollable';
  container.innerHTML = `
    <div class="vm--overlay" data-modal="poll_${id}" aria-expanded="true">
      <div class="vm--top-right-slot"></div>
    </div>
    <div class="vm--modal" role="dialog" aria-modal="true">
      <div class="modal-content" data-v-3f0a1b2c>
        <div class="modal-header"><h5>Instapoll</h5></div>
        <div class="modal-body">
          <p class="mathjax-convert" style="font-size:150%">${prompt}</p>
          <div>
            ${choices.map(c => `<div style="margin-bottom:8px"><button class="btn btn-primary"> </button> <span class="mathjax-convert">${c}</span><br></div>`).join('')}
          </div>
          <form><div class="form-group"></div></form>
        </div>
      </div>
    </div>`;
  window.document.getElementById('modals-container').appendChild(container);
}

// A non-poll modal that must NOT trigger anything (the "ask a question" dialog).
function showOtherModal() {
  const container = window.document.createElement('div');
  container.className = 'vm--container';
  container.innerHTML = `<div class="vm--overlay" data-modal="ask_question"></div>
    <div class="vm--modal"><div class="modal-content"><div class="modal-body">
    <p class="mathjax-convert">Ask a question</p></div></div></div>`;
  window.document.getElementById('modals-container').appendChild(container);
}

const results = [];
const assert = (name, cond) => results.push([name, !!cond]);

showPoll('4471', 'Which chord quality is built on scale degree ii?', ['Major', 'Minor', 'Diminished']);
showOtherModal();
showPoll('4471', 'duplicate', ['x']); // same id again -> must not re-announce

setTimeout(() => {
  const polls = sent.filter(m => m.type === 'poll');
  const texts = sent.filter(m => m.type === 'pollText');

  assert('announces exactly one poll', polls.length === 1);
  assert('announces the right id', polls[0] && polls[0].id === '4471');
  assert('marks source as dom', polls[0] && polls[0].source === 'dom');
  assert('ignores the non-poll modal', !sent.some(m => m.id === 'ask_question'));
  assert('scrapes exactly one prompt', texts.length === 1);
  assert('scrapes the prompt text',
    texts[0] && texts[0].prompt === 'Which chord quality is built on scale degree ii?');
  assert('scrapes all three choices', texts[0] && texts[0].choices.length === 3);
  assert('choices are correct',
    texts[0] && texts[0].choices.join('|') === 'Major|Minor|Diminished');

  // ---- detector 1: the page-world postMessage tap --------------------------
  // jsdom sets event.source=null for same-window postMessage; Chrome sets the
  // window. Dispatch the event Chrome actually delivers.
  const fire = (data, src) => window.dispatchEvent(new window.MessageEvent('message', {
    data, source: src, origin: 'https://tower.la.utexas.edu',
  }));
  fire({ __TOWER_INSTAPOLL_ALERT__: true, kind: 'poll', id: '9002', source: 'xhr' }, window);
  // A hostile frame forging the same payload must be ignored (source !== window).
  fire({ __TOWER_INSTAPOLL_ALERT__: true, kind: 'poll', id: '6666', source: 'xhr' }, {});
  // Wrong tag must be ignored.
  fire({ kind: 'poll', id: '7777' }, window);
  setTimeout(() => {
    const viaHook = sent.filter(m => m.type === 'poll' && m.id === '9002');
    assert('network tap announces', viaHook.length === 1);
    assert('network tap marks source', viaHook[0] && viaHook[0].source === 'xhr');
    assert('rejects forged message from another frame', !sent.some(m => m.id === '6666'));
    assert('rejects untagged message', !sent.some(m => m.id === '7777'));

    let failed = 0;
    for (const [name, ok] of results) {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }, 100);
}, 2500);
