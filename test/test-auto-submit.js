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
let clock;
const settle = () => clock.advance(1500);

async function scenario(run) {
  const dom = new JSDOM('<!doctype html><body><div id="modals-container"></div></body>', {
    url: 'https://tower.la.utexas.edu/app_home/dashboard', runScripts: 'outside-only',
  });
  const { window } = dom;
  clock = require('./fake-clock')(window);
  const clicks = [];
  window.chrome = {
    runtime: { sendMessage: (_msg, cb) => cb && cb(), lastError: null },
    storage: {
      sync: { get: (defaults, cb) => cb({ ...defaults, sound: false, flashTitle: false }) },
      onChanged: { addListener: () => {} },
    },
  };
  const container = window.document.createElement('div');
  container.className = 'vm--container';
  container.innerHTML = `<div data-modal="poll_42" aria-expanded="true"></div>
    <div class="vm--modal"><div class="modal-body">
      <p class="mathjax-convert">Question</p>
      <div><button type="button" class="btn-primary">A</button><span class="mathjax-convert">First</span></div>
    </div><div class="modal-footer"></div></div>`;
  const first = container.querySelector('button');
  first.onclick = () => clicks.push('first');
  const footer = container.querySelector('.modal-footer');
  function submit(label = 'Submit answer') {
    const button = window.document.createElement('button');
    button.textContent = label;
    button.onclick = () => clicks.push('submit');
    footer.append(button);
    return button;
  }
  function start() {
    window.document.getElementById('modals-container').append(container);
    window.eval(source);
  }
  try { await run({ window, container, first, footer, submit, start, clicks }); }
  finally { window.close(); }
}

(async () => {
  await scenario(async ({ submit, start, first, clicks, container }) => {
    const button = submit();
    button.disabled = true;
    first.onclick = () => { clicks.push('first'); button.disabled = false; };
    start();
    await settle();
    check('submits immediately after the delayed random selection enables submit', clicks, ['first', 'submit']);
    container.append(container.ownerDocument.createElement('span'));
    button.disabled = true;
    button.disabled = false;
    await settle();
    check('does not submit twice after DOM changes', clicks, ['first', 'submit']);
  });
  await scenario(async ({ start, submit, clicks }) => {
    start();
    await settle();
    check('selection works when no separate submit is present', clicks, ['first']);
    const button = submit('Submit');
    button.disabled = true;
    await settle();
    check('waits for a delayed submit button to be enabled', clicks, ['first']);
    button.disabled = false;
    await settle();
    check('submits as soon as the delayed button is enabled', clicks, ['first', 'submit']);
  });
  await scenario(async ({ start, submit, first, container, clicks }) => {
    submit();
    first.onclick = () => { clicks.push('first-and-submit'); container.remove(); };
    start();
    await settle();
    check('does not click submit after a one-click poll closes itself', clicks, ['first-and-submit']);
  });
  await scenario(async ({ start, submit, first, container, clicks }) => {
    const button = submit();
    button.disabled = true;
    first.disabled = true;
    start();
    await settle();
    check('does not submit before the first option is selected', clicks, []);
    first.disabled = false;
    await settle();
    container.remove();
    button.disabled = false;
    await settle();
    check('does not submit a removed poll', clicks, ['first']);
  });
  await scenario(async ({ start, submit, footer, clicks }) => {
    submit('Submit response');
    footer.style.display = 'none';
    start();
    await settle();
    check('does not click hidden submit controls', clicks, ['first']);
    footer.style.display = '';
    await settle();
    check('submits once the footer becomes visible', clicks, ['first', 'submit']);
  });
  await scenario(async ({ window, start, submit, first, clicks }) => {
    submit('Close');
    const other = window.document.createElement('button');
    other.textContent = 'Submit';
    other.onclick = () => clicks.push('outside');
    window.document.body.append(other);
    first.textContent = 'Submit'; // A choice label is never a submit control.
    start();
    await settle();
    check('ignores unrelated buttons, outside forms, and option labels', clicks, ['first']);
  });
  await scenario(async ({ start, submit, clicks }) => {
    const button = submit('Sending…');
    start();
    await settle();
    button.firstChild.data = 'Submit poll';
    await settle();
    check('recognizes a submit label when its text changes', clicks, ['first', 'submit']);
  });
  await scenario(async ({ window, start, footer, clicks }) => {
    const form = window.document.createElement('form');
    form.innerHTML = '<input type="submit" value="Submit answer">';
    form.onsubmit = event => { event.preventDefault(); clicks.push('form-submitted'); };
    footer.append(form);
    start();
    await settle();
    check('clicks submit inputs through the normal form event', clicks, ['first', 'form-submitted']);
  });
  console.log(`\n${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
