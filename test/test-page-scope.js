const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
let passed = 0;
function check(name, run) {
  run();
  console.log(`PASS  ${name}`);
  passed++;
}

check('manifest only permits Tower pages and explicitly excludes UT Instapoll', () => {
  assert.deepEqual(manifest.host_permissions, ['https://tower.la.utexas.edu/*']);
  for (const script of manifest.content_scripts) {
    assert.deepEqual(script.matches, ['https://tower.la.utexas.edu/*']);
    assert.deepEqual(script.exclude_matches, [
      'https://polls.la.utexas.edu/*',
      'https://tower.la.utexas.edu/app_home/quiz*',
    ]);
  }
});

for (const file of ['hook.js', 'content.js']) {
  for (const url of [
    'https://polls.la.utexas.edu/course/6298/student',
    'https://polls.la.utexas.edu/course/6298/student/?x=1#poll',
    'https://example.com/',
    'http://tower.la.utexas.edu/',
    'https://tower.la.utexas.edu/app_home/quiz',
    'https://tower.la.utexas.edu/app_home/quiz?act_key=test-value#/',
    'https://tower.la.utexas.edu/app_home/quiz/123?act_key=another-value',
    'https://tower.la.utexas.edu/app_home/quizzes',
  ]) {
    check(`${file} exits without touching page APIs on ${url}`, () => {
      // Any attempt to access window, chrome, XHR, or the DOM would throw.
      vm.runInNewContext(read(file), { location: new URL(url) });
    });
  }
  check(`${file} exits in a Tower iframe nested beneath UT Instapoll`, () => {
    vm.runInNewContext(read(file), {
      location: {
        origin: 'https://tower.la.utexas.edu',
        ancestorOrigins: ['https://tower.la.utexas.edu', 'https://polls.la.utexas.edu', 'https://utexas.instructure.com'],
      },
    });
  });
  for (const ancestors of [[], ['https://utexas.instructure.com']]) {
    check(`${file} proceeds on Tower with ancestors ${JSON.stringify(ancestors)}`, () => {
      const marker = new Error('page API accessed');
      const context = { location: { origin: 'https://tower.la.utexas.edu', ancestorOrigins: ancestors } };
      // The first real page API proves initialization wasn't excluded.
      context.XMLHttpRequest = { get prototype() { throw marker; } };
      context.window = { addEventListener() { throw marker; } };
      assert.throws(() => vm.runInNewContext(read(file), context), error => error === marker);
    });
  }
}
console.log(`\n${passed}/${passed} passed`);
