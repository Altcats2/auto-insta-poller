/*
 * Runs in the PAGE's JS world at document_start, before Tower's bundles load.
 *
 * Tower logs every instapoll lifecycle stage to its own backend. The earliest
 * one is "received", fired from the modal's `before-open` hook -- i.e. after the
 * app has decided a poll is for you, but before the modal DOM exists. Tapping
 * that POST is the fastest reliable signal available.
 *
 *   POST /log_endpoints/instapoll_activity_log.php
 *   { event_type: "received", instapoll_id, course_id, activity_id, user_id }
 *
 * We only read; nothing is modified, blocked or replayed. Findings are handed to
 * the isolated content script via postMessage.
 */
(() => {
  'use strict';

  const isQuizPage = () => typeof location === 'undefined' || /^\/app_home\/quiz/i.test(location.pathname);

  // Never run on quiz pages or UT Instapoll, including frames under that site.
  if (location.origin !== 'https://tower.la.utexas.edu' ||
      isQuizPage() ||
      Array.from(location.ancestorOrigins || []).includes('https://polls.la.utexas.edu')) return;

  const TAG = '__TOWER_INSTAPOLL_ALERT__';
  const ACTIVITY_LOG = 'instapoll_activity_log';

  const emit = (payload) => {
    if (isQuizPage()) return;
    try {
      window.postMessage(Object.assign({ [TAG]: true }, payload), window.location.origin);
    } catch (_) { /* never let the tap break the page */ }
  };

  // Returns the poll id if this request is Tower announcing an incoming poll.
  const pollIdFromActivityLog = (url, body) => {
    if (typeof url !== 'string' || url.indexOf(ACTIVITY_LOG) === -1) return null;
    let data = body;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { return null; }
    }
    if (!data || typeof data !== 'object') return null;
    // "received" fires on before-open; "displayed" on opened. Either means a poll landed.
    if (data.event_type !== 'received' && data.event_type !== 'displayed') return null;
    if (data.instapoll_id === undefined || data.instapoll_id === null) return null;
    return String(data.instapoll_id);
  };

  const inspect = (url, body, source) => {
    if (isQuizPage()) return;
    const id = pollIdFromActivityLog(url, body);
    if (id) emit({ kind: 'poll', id, source });
  };

  // --- XMLHttpRequest (axios uses this by default) ---------------------------
  const XhrProto = XMLHttpRequest.prototype;
  const openOrig = XhrProto.open;
  const sendOrig = XhrProto.send;

  XhrProto.open = function (method, url) {
    try { this.__towerUrl = url; } catch (_) {}
    return openOrig.apply(this, arguments);
  };

  XhrProto.send = function (body) {
    try { inspect(this.__towerUrl, body, 'xhr'); } catch (_) {}
    return sendOrig.apply(this, arguments);
  };

  // --- fetch (in case the bundle ever switches) ------------------------------
  if (typeof window.fetch === 'function') {
    const fetchOrig = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url);
        const body = (init && init.body) !== undefined ? init.body : (input && input.body);
        inspect(url, body, 'fetch');
      } catch (_) {}
      return fetchOrig.apply(this, arguments);
    };
  }
})();
