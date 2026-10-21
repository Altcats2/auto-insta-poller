/* Behavioral coverage for delayed random-choice clicks using Tower's modal shape. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body><div id="modals-container"></div></body>', {
  url: 'https://tower.la.utexas.edu/app_home/dashboard',
  runScripts: 'outside-only',
});
const { window } = dom;
const clock = require('./fake-clock')(window);
window.Math.random = () => 0;
window.chrome = {
  runtime: { sendMessage: (_msg, cb) => cb && cb(), lastError: null },
  storage: {
    sync: { get: (defaults, cb) => cb({ ...defaults, sound: false, flashTitle: false }) },
    onChanged: { addListener: () => {} },
  },
};
window.eval(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'));

const clicks = [];
const settle = () => clock.advance(1500);
let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`PASS  ${name}`);
  passed++;
}
function modal(id, name = `poll_${id}`) {
  const container = window.document.createElement('div');
  container.className = 'vm--container';
  container.innerHTML = `<div class="vm--overlay" data-modal="${name}" aria-expanded="true"></div>
    <div class="vm--modal"><div class="modal-body">
      <p class="mathjax-convert">Question</p><div class="choices"></div>
      <button class="btn-primary" data-unrelated>Close</button>
    </div></div>`;
  container.querySelector('[data-unrelated]').onclick = () => clicks.push(`${id}:submit`);
  window.document.getElementById('modals-container').append(container);
  return container;
}
function choices(container, id, disabled = false) {
  const rows = container.querySelector('.choices');
  rows.innerHTML = [0, 1, 2].map(index =>
    `<div><button type="button" class="btn btn-primary" ${disabled ? 'disabled' : ''}></button>
      <span class="mathjax-convert">Choice ${index + 1}</span><br></div>`
  ).join('');
  const buttons = Array.from(rows.querySelectorAll('button'));
  buttons.forEach((button, index) => {
    button.onclick = () => clicks.push(`${id}:${index}`);
  });
  return buttons;
}

(async () => {
  const first = modal('1');
  choices(first, '1');
  await clock.advance(0);
  check('does not click immediately', clicks, []);
  await clock.advance(1499);
  check('does not click before 1.5 seconds', clicks, []);
  await clock.advance(1);
  check('clicks the randomly chosen option at 1.5 seconds with alerts off', clicks, ['1:0']);

  choices(first, '1'); // Rerender the same modal.
  choices(modal('1'), 'duplicate');
  await settle();
  check('does not click again after rerender or duplicate modal', clicks, ['1:0']);

  const delayed = modal('2');
  await settle();
  check('waits for choices without clicking unrelated buttons', clicks, ['1:0']);
  choices(delayed, '2');
  await settle();
  check('clicks when choices mount after the overlay', clicks, ['1:0', '2:0']);

  const disabled = choices(modal('3'), '3', true);
  await settle();
  check('waits when all choices are disabled', clicks, ['1:0', '2:0']);
  disabled[0].disabled = false;
  await settle();
  check('clicks when an option becomes enabled after the delay', clicks, ['1:0', '2:0', '3:0']);

  choices(modal('4', 'ask_question'), 'other');
  const orphan = window.document.createElement('div');
  orphan.setAttribute('data-modal', 'poll_5');
  window.document.body.append(orphan);
  await settle();
  check('ignores non-poll dialogs and overlays without their own container', clicks, ['1:0', '2:0', '3:0']);

  const removed = modal('6');
  const removedButtons = choices(removed, '6', true);
  await settle();
  removed.remove();
  removedButtons[0].disabled = false;
  await settle();
  check('does not click an option after the poll is removed', clicks, ['1:0', '2:0', '3:0']);

  const collapsed = modal('7');
  const overlay = collapsed.querySelector('[data-modal]');
  overlay.setAttribute('aria-expanded', 'false');
  choices(collapsed, '7');
  await settle();
  check('waits while a poll overlay is collapsed', clicks, ['1:0', '2:0', '3:0']);
  overlay.setAttribute('aria-expanded', 'true');
  await settle();
  check('clicks when the poll opens', clicks, ['1:0', '2:0', '3:0', '7:0']);

  const ariaDisabled = choices(modal('8'), '8');
  ariaDisabled.forEach(button => button.setAttribute('aria-disabled', 'true'));
  await settle();
  check('respects aria-disabled on options', clicks, ['1:0', '2:0', '3:0', '7:0']);
  ariaDisabled[0].removeAttribute('aria-disabled');
  await settle();
  check('retries when aria-disabled is removed', clicks, ['1:0', '2:0', '3:0', '7:0', '8:0']);

  const noChoices = modal('9');
  noChoices.querySelector('.choices').innerHTML = '<form><input type="text"><button>Submit</button></form>';
  noChoices.querySelector('form').onsubmit = event => {
    event.preventDefault();
    clicks.push('free-text-submit');
  };
  await settle();
  check('leaves free-text polls alone', clicks, ['1:0', '2:0', '3:0', '7:0', '8:0']);

  window.Math.random = () => 0.5;
  choices(modal('10'), '10');
  await settle();
  check('can randomly select the middle choice', clicks.at(-1), '10:1');
  window.Math.random = () => 0.999;
  choices(modal('11'), '11');
  await settle();
  check('can randomly select the last choice', clicks.at(-1), '11:2');

  const eligible = choices(modal('12'), '12');
  eligible[0].disabled = true;
  eligible[2].parentElement.hidden = true;
  window.Math.random = () => 0;
  await settle();
  check('random selection excludes disabled and hidden choices', clicks.at(-1), '12:1');

  const changing = modal('13');
  choices(changing, 'stale');
  await clock.advance(1000);
  choices(changing, '13');
  await clock.advance(499);
  check('rerender does not cause an early click', clicks.at(-1), '12:1');
  await clock.advance(1);
  check('timer uses fresh buttons without restarting after a rerender', clicks.at(-1), '13:0');

  const closing = modal('14');
  choices(closing, '14');
  await clock.advance(1000);
  closing.remove();
  await clock.advance(500);
  check('closing a poll during the delay cancels its click', clicks.at(-1), '13:0');

  choices(modal('15'), '15');
  await clock.advance(1000);
  window.history.pushState({}, '', '/app_home/quiz?act_key=test#/');
  await clock.advance(500);
  check('quiz navigation during the delay cancels the click without a DOM change', clicks.at(-1), '13:0');
  console.log(`\n${passed}/${passed} passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => window.close());
