/* Exercises hook.js's tap against the exact payloads Tower's axios calls send. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const hookSrc = fs.readFileSync(require('path').join(__dirname, '..', 'hook.js'), 'utf8');
const dom = new JSDOM(`<!doctype html><body></body>`, {
  url: 'https://tower.la.utexas.edu/app_home/dashboard', runScripts: 'outside-only',
});
const { window } = dom;

// Neutralise real I/O before hook.js wraps these.
window.XMLHttpRequest.prototype.open = function () {};
window.XMLHttpRequest.prototype.send = function () {};
window.fetch = () => Promise.resolve({});

const posted = [];
window.addEventListener('message', (e) => {
  if (e.data && e.data.__TOWER_INSTAPOLL_ALERT__) posted.push(e.data);
});

window.eval(hookSrc);

const xhr = (url, body) => {
  const r = new window.XMLHttpRequest();
  r.open('POST', url);
  r.send(typeof body === 'string' ? body : JSON.stringify(body));
};

const base = { course_id: 1455185, activity_id: 'none', user_id: 42 };

// The real "poll arrived" call, fired from the modal's before-open hook.
xhr('/log_endpoints/instapoll_activity_log.php', { ...base, event_type: 'received', instapoll_id: 4471 });
// The follow-up when the modal actually opens.
xhr('/log_endpoints/instapoll_activity_log.php', { ...base, event_type: 'displayed', instapoll_id: 4471 });
// Stages that must NOT alert.
xhr('/log_endpoints/instapoll_activity_log.php', { ...base, event_type: 'answered', instapoll_id: 4471 });
xhr('/log_endpoints/instapoll_activity_log.php', { ...base, event_type: 'expired', instapoll_id: 4471 });
// Unrelated traffic.
xhr('/log_endpoints/instapoll_response', { instapoll_id: 4471, response: 'Minor' });
xhr('/session-config', null);
xhr('/utv1988a/lep', { position: 812, status: 'playing' });
// Malformed body must not throw.
xhr('/log_endpoints/instapoll_activity_log.php', 'not json at all');

window.fetch('/log_endpoints/instapoll_activity_log.php', {
  method: 'POST', body: JSON.stringify({ ...base, event_type: 'received', instapoll_id: 5150 }),
});

setTimeout(() => {
  const results = [
    ['emits for received + displayed only', posted.filter(p => p.id === '4471').length === 2],
    ['ignores answered/expired', !posted.some(p => p.stage === 'answered')],
    ['ignores non-activity-log traffic', posted.every(p => p.id === '4471' || p.id === '5150')],
    ['fetch path works', posted.some(p => p.id === '5150' && p.source === 'fetch')],
    ['xhr path labels source', posted.some(p => p.id === '4471' && p.source === 'xhr')],
    ['ids are strings', posted.every(p => typeof p.id === 'string')],
    ['total emissions is 3', posted.length === 3],
  ];
  let failed = 0;
  for (const [name, ok] of results) { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}, 200);
