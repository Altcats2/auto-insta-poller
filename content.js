/*
 * Isolated-world half. Two independent detectors feed one deduplicated stream:
 *
 *   1. hook.js's tap on Tower's own "received" activity-log POST (fastest).
 *   2. A MutationObserver on #modals-container. Tower shows polls through
 *      vue-js-modal under the name `poll_<id>`, and vue-js-modal stamps that name
 *      onto the overlay as data-modal="poll_<id>". This is the backstop: it works
 *      for instructor accounts (which skip activity logging) and survives any
 *      change to the logging endpoint.
 *
 * Detector 2 also scrapes the question text, which detector 1 cannot see. The
 * notification is raised immediately on whichever fires first, then updated in
 * place once the text is available.
 */
(() => {
  'use strict';

  const isQuizPage = () => typeof location === 'undefined' || /^\/app_home\/quiz/i.test(location.pathname);

  // Never run on quiz pages or UT Instapoll, including frames under that site.
  if (location.origin !== 'https://tower.la.utexas.edu' ||
      isQuizPage() ||
      Array.from(location.ancestorOrigins || []).includes('https://polls.la.utexas.edu')) return;

  const TAG = '__TOWER_INSTAPOLL_ALERT__';
  const MODAL_NAME = /^poll_(\d+)$/;
  const seen = new Set();      // poll ids already announced this page load
  const described = new Set(); // poll ids whose text we've already sent
  const clicked = new Set();   // poll options clicked this page load
  const submitted = new Set(); // explicit submit buttons clicked this page load
  const choiceWatchers = new Map();

  const send = (message) => {
    if (isQuizPage()) return;
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (_) { /* extension reloaded out from under the page */ }
  };

  // ---- audible ping ---------------------------------------------------------
  // Synthesised so the extension ships no audio asset. Browsers may keep the
  // context suspended until the page has seen a user gesture; by the time a poll
  // lands the student has normally clicked something, but this stays best-effort.
  let audioCtx = null;
  function beep() {
    if (isQuizPage()) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const now = audioCtx.currentTime;
      [0, 0.18].forEach((offset, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = i === 0 ? 880 : 1175;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.16);
      });
    } catch (_) {}
  }

  // ---- title flash (only meaningful outside the Canvas iframe) --------------
  let titleTimer = null;
  function flashTitle() {
    if (isQuizPage()) return;
    if (window.top !== window) return;
    const original = document.title;
    let on = false;
    clearInterval(titleTimer);
    titleTimer = setInterval(() => {
      if (isQuizPage()) { stop(); return; }
      document.title = (on = !on) ? '\u25CF INSTAPOLL' : original;
    }, 800);
    const stop = () => {
      clearInterval(titleTimer);
      document.title = original;
      document.removeEventListener('visibilitychange', onVisible);
    };
    const onVisible = () => { if (!document.hidden) stop(); };
    document.addEventListener('visibilitychange', onVisible);
    setTimeout(stop, 60000);
  }

  // ---- announce -------------------------------------------------------------
  function announce(id, source) {
    if (isQuizPage()) return;
    if (!id || seen.has(id)) return;
    seen.add(id);
    send({ type: 'poll', id, source, url: location.href });
    try {
      chrome.storage.sync.get({ sound: true, flashTitle: true }, (opts) => {
        if (chrome.runtime.lastError) return;
        if (opts.sound) beep();
        if (opts.flashTitle) flashTitle();
      });
    } catch (_) { /* extension reloaded out from under the page */ }
  }

  function describe(id, prompt, choices) {
    if (isQuizPage()) return;
    if (!id || !prompt || described.has(id)) return;
    described.add(id);
    send({ type: 'pollText', id, prompt, choices });
  }

  // ---- detector 1: the page-world network tap -------------------------------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[TAG] !== true || data.kind !== 'poll') return;
    announce(String(data.id), data.source);
  });

  // ---- detector 2: the modal itself -----------------------------------------
  const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  function scrape(id, overlay) {
    // Overlay and modal body are siblings under the same .vm--container, and the
    // body mounts a beat after the overlay, so retry briefly.
    let attempts = 0;
    const tick = () => {
      if (isQuizPage()) return;
      const container = overlay.closest('.vm--container') || document;
      const promptEl = container.querySelector('.modal-body p.mathjax-convert');
      if (promptEl) {
        const choices = Array.from(
          container.querySelectorAll('.modal-body span.mathjax-convert')
        ).map(text).filter(Boolean);
        describe(id, text(promptEl), choices);
        return;
      }
      if (++attempts < 12) setTimeout(tick, 150);
    };
    tick();
  }

  // Wait 1.5 seconds from detecting the modal, then choose uniformly from its
  // currently enabled, visible options. Re-read the DOM when the timer fires.
  function clickRandomChoice(id, overlay) {
    if (isQuizPage() || !autoAnswer) return;
    const container = overlay.closest('.vm--container');
    if (!container || clicked.has(id) || choiceWatchers.has(container)) return;
    let selectedHere = false;
    let delayElapsed = false;
    let selectionTimer = null;
    const ready = (button) => {
      if (button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true' ||
          button.closest('[hidden], [aria-hidden="true"]')) return false;
      for (let el = button; el && container.contains(el); el = el.parentElement) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    };

    const stop = () => {
      clearTimeout(selectionTimer);
      watcher.disconnect();
      choiceWatchers.delete(container);
    };
    const attempt = () => {
      if (isQuizPage()) { stop(); return; }
      if (!autoAnswer || !container.isConnected || !overlay.isConnected || submitted.has(id) ||
          (clicked.has(id) && !selectedHere)) {
        stop();
        return;
      }
      if (overlay.getAttribute('data-modal') !== `poll_${id}`) {
        stop();
        return;
      }
      if (overlay.getAttribute('aria-expanded') === 'false' ||
          container.closest('[hidden], [aria-hidden="true"]')) return;

      if (selectedHere) {
        // Some polls submit on the option click; others render/enable an
        // explicit submit control afterward. Only follow that control here.
        const candidates = Array.from(container.querySelectorAll(
          '.modal-body button, .modal-footer button, .modal-body input[type="submit"], .modal-footer input[type="submit"]'
        )).filter(button => {
          if (button.closest('.vm--container') !== container) return false;
          if (button.nextElementSibling?.matches('span.mathjax-convert')) return false;
          const label = (button.getAttribute('aria-label') ||
            (button.tagName === 'INPUT' ? button.value : text(button))).trim();
          return /^submit(?:\s+(?:answer|response|poll))?$/i.test(label);
        });
        const button = candidates.find(ready);
        if (!button) return;
        submitted.add(id);
        stop();
        button.click();
        return;
      }

      if (!delayElapsed) return;
      const buttons = Array.from(container.querySelectorAll('.modal-body span.mathjax-convert'))
        .map(choice => choice.previousElementSibling)
        .filter(button => button && button.matches('button.btn-primary') &&
          button.closest('.vm--container') === container && ready(button));
      if (!buttons.length) return;
      const button = buttons[Math.floor(Math.random() * buttons.length)];

      // Mark before clicking: Tower's click handler may synchronously rerender.
      clicked.add(id);
      selectedHere = true;
      button.click();
      attempt(); // Submit immediately if Tower made the control ready synchronously.
    };
    const watcher = new MutationObserver(attempt);
    choiceWatchers.set(container, { stop, id });
    watcher.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['disabled', 'aria-disabled', 'aria-expanded', 'hidden', 'aria-hidden', 'data-modal', 'class', 'style', 'aria-label', 'value'],
    });
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      delayElapsed = true;
      attempt();
    }, 1500);
    attempt();
  }

  // ---- the auto-answer switch ----------------------------------------------
  // Read once at startup and then tracked live, so flipping it acts on a poll
  // that is already on screen: off cancels a pending selection, on picks up a
  // modal that is still waiting. Selection stays off until the stored value
  // arrives, and any modal seen in the meantime is replayed once it does.
  let autoAnswer = false;
  const openModals = new Map(); // poll id -> overlay, for replay when switched on

  function applyAutoAnswer(enabled) {
    autoAnswer = !!enabled;
    if (!autoAnswer) {
      for (const [, watcher] of choiceWatchers) watcher.stop();
      disarmDismiss();
      return;
    }
    for (const [id, overlay] of openModals) {
      if (overlay.isConnected) clickRandomChoice(id, overlay);
      else openModals.delete(id);
    }
  }

  try {
    chrome.storage.sync.get({ autoAnswer: true }, (values) => {
      if (chrome.runtime.lastError) return;
      applyAutoAnswer(values.autoAnswer);
    });
  } catch (_) { /* extension reloaded out from under the page */ }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.autoAnswer) return;
      applyAutoAnswer(changes.autoAnswer.newValue);
    });
  } catch (_) {}

  // ---- dismiss the confirmation after answering ----------------------------
  // Any click inside a poll modal, whether ours or the student's, arms a
  // 15-second window. That covers polls that submit on the option click as well
  // as those with a separate Submit button. A SweetAlert2 popup that appears in
  // the window is confirmed once its open animation has had 300 ms, unless it
  // shows an error or warning. Other dialogs, which the student may have opened,
  // are left alone. Follows the auto-answer switch.
  const DISMISS_WINDOW_MS = 15000;
  const LOG = '[Tower Instapoll Alert]';
  let dismissTimer = null;   // ends the armed window
  let dismissPending = null; // debounces mutations into one attempt
  let dismissWatcher = null;

  const buttonLabel = (el) =>
    (text(el) || el.value || el.getAttribute('aria-label') || el.title || '').trim();
  const shown = (el) => {
    if (!el || el.disabled) return false;
    for (; el; el = el.parentElement) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const inPoll = (el) => {
    const container = el.closest('.vm--container');
    return !!container && Array.from(container.querySelectorAll('[data-modal]'))
      .some(overlay => MODAL_NAME.test(overlay.getAttribute('data-modal') || ''));
  };

  function disarmDismiss() {
    clearTimeout(dismissTimer);
    clearTimeout(dismissPending);
    dismissTimer = dismissPending = null;
    if (dismissWatcher) dismissWatcher.disconnect();
    dismissWatcher = null;
  }

  function dismissConfirmation() {
    dismissPending = null;
    if (isQuizPage() || !autoAnswer) { disarmDismiss(); return; }

    const popup = Array.from(document.querySelectorAll('.swal2-container .swal2-popup')).find(shown);
    if (popup) {
      const bad = Array.from(popup.querySelectorAll('.swal2-icon.swal2-error, .swal2-icon.swal2-warning'))
        .some(shown);
      if (bad) { console.log(LOG, 'leaving SweetAlert error/warning on screen'); return; }
      const ok = popup.querySelector('button.swal2-confirm');
      if (shown(ok)) {
        console.log(LOG, 'dismissing SweetAlert:', buttonLabel(ok));
        ok.click();
      }
    }
  }

  function armDismiss() {
    disarmDismiss();
    console.log(LOG, `watching ${DISMISS_WINDOW_MS / 1000} s for a confirmation popup`);
    dismissWatcher = new MutationObserver(() => {
      if (!dismissPending) dismissPending = setTimeout(dismissConfirmation, 300);
    });
    dismissWatcher.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'],
    });
    dismissTimer = setTimeout(disarmDismiss, DISMISS_WINDOW_MS);
  }

  // Capture phase, so this runs before Tower's handler can rerender the modal.
  document.addEventListener('click', (event) => {
    if (isQuizPage() || !autoAnswer || !event.target.closest) return;
    const control = event.target.closest('button, input, a');
    if (control && inPoll(control)) armDismiss();
  }, true);

  function examine(node) {
    if (isQuizPage()) return;
    if (!node || node.nodeType !== 1) return;
    const hits = [];
    if (node.matches && node.matches('[data-modal]')) hits.push(node);
    if (node.querySelectorAll) {
      hits.push(...node.querySelectorAll('[data-modal]'));
    }
    for (const el of hits) {
      const match = MODAL_NAME.exec(el.getAttribute('data-modal') || '');
      if (!match) continue;
      const id = match[1];
      announce(id, 'dom');
      scrape(id, el);
      openModals.set(id, el);
      clickRandomChoice(id, el);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const [id, overlay] of openModals) {
      if (!overlay.isConnected) openModals.delete(id);
    }
    for (const [container, { stop, id }] of choiceWatchers) {
      if (isQuizPage() || !container.isConnected || submitted.has(id)) {
        stop();
      }
    }
    for (const record of records) {
      for (const node of record.addedNodes) examine(node);
    }
  });

  const start = () => {
    const root = document.body || document.documentElement;
    if (!root) return;
    observer.observe(root, { childList: true, subtree: true });
    examine(root); // catch a modal that somehow beat us here
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
