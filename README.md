# Tower Instapoll Alert

A Chrome/Brave (MV3) extension that fires a desktop notification and a sound the
moment an instapoll appears in UT Tower, so one doesn't slip past in a background
tab. When **automatic answering** is on, it also clicks a random option 1.5
seconds after detecting the poll modal, then clicks an explicit Submit button if
one is present and enabled. Some polls submit directly on the option click.
Automatic answering is a setting: switch it off and the extension only alerts.

# NOTE: This project is NOT intended to allow you to "cheat" your attendance in any way, shape, or form and should not be used in any setting where this behavior constitutes academic dishonestly. This project simply serves as an interesting exploration into how the technology behind the instapoll system works and potential vulnerabilities within this system. Any use of this extension is your own responsibility and the provision of this repository does not constitute approval of any unauthorized uses. 

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the extension icon → **Send a test alert** to confirm the OS is actually
   showing notifications (Windows Focus Assist silently swallows them otherwise)

The test button waits five seconds between sends. Each test has a fresh
notification ID, and the settings page reports browser errors instead of always
claiming success. Browser acceptance does not confirm that Windows displayed a
banner; if none appears, check Windows notifications and Do not disturb/Focus
Assist. The test checks desktop notifications, not the page's synthesized sound.

## How it detects a poll

The extension runs only on `https://tower.la.utexas.edu/`. It does not run on
`https://polls.la.utexas.edu/course/6298/student` or any other page on
`polls.la.utexas.edu`. Tower frames embedded beneath that site are also excluded
from detection, alerts, automatic selection, and submission. Tower embedded
directly in Canvas remains supported.

Tower quiz routes beginning with `/app_home/quiz` are also excluded, regardless
of their query parameters or hash. Both detectors exit on those pages, and
pending detection/selection/submission callbacks recheck the route in case Tower
navigates to a quiz without reloading the document.

Two independent detectors feed one deduplicated stream, keyed on poll id.

**1. Tower's own activity log** (`hook.js`, page world, `document_start`)

Tower logs each poll lifecycle stage to its backend. The earliest is `received`,
fired from the modal's `before-open` hook — after the app has decided a poll is
yours, but before any modal DOM exists:

```
POST /log_endpoints/instapoll_activity_log.php
{ event_type: "received", instapoll_id, course_id, activity_id, user_id }
```

`hook.js` wraps `XMLHttpRequest.prototype.send` and `fetch` to read that request
as it goes past. It is a read-only tap: nothing is modified, blocked, or replayed.

**2. The modal itself** (`content.js`, isolated world)

Tower shows polls via vue-js-modal under the name `poll_<id>`, and vue-js-modal
stamps that onto the overlay as `data-modal="poll_<id>"` inside `#modals-container`.
A `MutationObserver` watches for it. This is the backstop: it survives any change
to the logging endpoint, and it covers instructor accounts, which skip activity
logging entirely (`if (!config_data.allow_tool_edit)`).

Detector 2 also scrapes the question text and choices from
`.modal-body p.mathjax-convert` / `span.mathjax-convert`, which detector 1 cannot
see. The notification is raised immediately on whichever detector fires first,
then updated in place once the text is available — so the alert is never delayed
waiting for the DOM.

## Automatic random option

Controlled by **Answer polls automatically** in the options page, on by default.
With it off, both detectors still run and alerts still fire, but nothing on the
page is ever clicked.

For each poll, the extension waits 1.5 seconds after detecting its modal, then
randomly selects one of that modal's enabled, visible choice buttons with equal
probability. It reads the available choices at click time. If none are ready
after the delay, it waits for an available choice. Alerts still fire immediately.
Closing the modal or navigating to a quiz cancels pending clicks. Browser timer
throttling can make the delay longer than 1.5 seconds in a background tab. It
works independently of the alert settings.

The switch takes effect immediately, including on a poll already on screen.
Turning it off cancels a selection that is still counting down and stops the
watcher looking for a Submit button; turning it on starts the 1.5-second delay
for any poll modal still open. Until the stored value has been read at page load
nothing is clicked, and a poll that lands in that window is picked up as soon as
the value arrives.

Selection and explicit submission each run once per poll ID per page load.
Reloading the page resets this click history. After selection, the extension
immediately clicks an enabled button labeled Submit, Submit answer, Submit
response, or Submit poll within the same modal. It also watches for that button
to render or become enabled later. Polls without recognized multiple-choice
buttons are left alone.

### Dismissing the confirmation

A click inside a poll modal starts a 15-second window. That includes an option
click, a Submit click, the extension's own clicks, and clicks made by hand. It
covers polls that submit on the option click and polls with a separate Submit
button. If a SweetAlert2 popup appears during the window, the extension waits
300 ms for its opening animation and then clicks its confirm button
(`button.swal2-confirm`).

Popups with an error or warning icon stay on screen. No other dialog is clicked,
including the poll modal, because the student may have opened it. Clicks outside
a poll modal do not start the window. This feature follows the **Answer polls
automatically** switch; when the switch is off, nothing is dismissed. The
console logs `[Tower Instapoll Alert]` lines when the window starts and when a
popup is confirmed or left on screen.

This initiates submission through Tower's own controls; it does not confirm that
Tower's server accepted the answer or retry failed submissions. The two-step
flow is tested with reconstructed modal fixtures, not a live course session.

## Why it works when Tower alone doesn't

- **The notification comes from the service worker**, not the page, so it fires
  with the tab backgrounded or the browser minimised.
- **The content script runs in all frames.** Tower is normally embedded in a
  Canvas LTI iframe, so the poll modal lives in a subframe, not the top document.
- Tower's live path has **no recovery for missed polls**: `refresh_course_after_sleep`
  is dead code (never called, and it contains a stray `$scope.get_course()` that
  would throw anyway). If the websocket drops or the machine sleeps, the poll is
  simply never shown. This extension can only alert on polls that reach the page —
  it cannot resurrect one the page never received — but the persistent
  notification means an alert that *did* fire won't be missed while you're away.

## Options

Icon → options, or right-click → Options.

| Setting | Default | Notes |
|---|---|---|
| Answer polls automatically | on | Off = alerts only, nothing is clicked |
| Desktop notification | on | Works when the tab is backgrounded |
| Keep notification until dismissed | on | Off = fades in seconds, easy to miss |
| Play a sound | on | Synthesised, no audio asset shipped |
| Flash the tab title | on | Only when Tower is its own tab, not in Canvas |
| Jump to the Tower tab | **off** | Clicking the notification always works |

## Known limits

- **Sound needs a prior click on the Tower page.** Browser autoplay policy keeps
  the AudioContext suspended until the frame has seen a user gesture. Normally
  satisfied by the time a poll lands; the desktop notification does not depend on it.
- **Title flashing does nothing inside Canvas** — an iframe's `document.title` is
  not the tab title. The notification is the reliable channel there.
- **Recorded-video (VOD) polls fire on playback position.** That app schedules
  polls from `config.timing` against `video.currentTime()` on a 1 s interval, so
  an alert only fires when playback actually reaches the timestamp.
- Desktop notification dedup is per poll id for the browser session. Sound,
  title flashing, and automatic clicks deduplicate per page load.
- The `data-modal` and `mathjax-convert` selectors track Tower's current bundles.
  If UT ships a redesign, detector 2 may need updating; detector 1 is independent
  of the markup.

## Tests

`test/` covers both detectors against a reconstruction of the real modal DOM and
the real activity-log payloads, including negative cases (non-poll modals, other
lifecycle stages, forged cross-frame messages). Automatic-click tests cover
the 1.5-second delay, random choices, disabled options, duplicate polls, and
unrelated buttons. Toggle tests cover gating, flipping the switch mid-poll, and
a poll that arrives before the stored value is read. Dismissal tests cover SweetAlert2
confirmations after one-click and two-step polls, error and warning popups that
stay on screen, other dialogs left open, the 15-second window, and clicks that
should not start it.

```
cd test && npm install && npm test
```

`node_modules/` inside `test/` is harmless — Chrome ignores it when loading unpacked.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; both content scripts at `document_start`, `all_frames` |
| `hook.js` | Page-world XHR/fetch tap on the activity-log endpoint |
| `content.js` | Isolated-world MutationObserver, delayed random-option click and its on/off switch, post-submit popup dismissal, dedup, sound, title flash |
| `background.js` | Service worker: notifications, badge, tab focus |
| `options.html` / `options.js` | Settings |
| `icons/make-icons.js` | Regenerates the PNGs (no dependencies) |
