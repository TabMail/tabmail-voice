## ADR-DESK-021: Tips that retire once learned, and hands-free dictation on a double tap

**Context:** Owner, 2026-09-26: the Space hint (ADR-DESK-011 amendment) should become a real tip,
"sort of a TipKit": "Press space to switch between dictation and agent mode", shown at the
beginning. After a dictation held for more than 20 seconds, a second tip: double-tap the hotkey to
dictate without holding it. The double tap starts a hands-free dictation that goes on until the
hotkey is tapped again (finish) or Escape is pressed (cancel). The double tap ADR-DESK-011 removed was
for agent mode; this one is for dictation, and Space still switches the mode.

**Decision:**
- Tips (`DictationTip`, `TipBook`) behave as TipKit's: a tip shows until the user has done what it
  teaches, or has seen it ~~`switchModeTipMaxDisplays`~~ (10) / ~~`doubleTapTipMaxDisplays`~~ (5) times
  (now each tip's `DictationConfig.TipSettings.maxDisplays`, amendment 2026-09-27),
  then never again; the counts and the learned flags are kept in UserDefaults (`tip.<name>.displays`,
  `tip.<name>.learned`; no user content). Switching the mode learns the Space tip; a double tap
  learns the double-tap tip. The TipKit framework itself is not used: the overlay is a click-through,
  non-activating panel, so TipKit's views (dismissed by a click) do not fit, and its rules and
  datastore are global state a unit test cannot own.
- The controller decides which tip shows (`DictationController.tip`); the overlay draws it in the
  same dark tooltip under the pill (`TipTooltip`, formerly `ModeHint`) and shows none over the warm-up
  swirl. The tip is hidden until it has measured itself (`useSize`), so it never shows for a frame
  at the wrong size or place (owner, 2026-09-30: fix the blink "for the agent answer tool and the
  tooltips" too). The Space tip is due as the pill starts listening; the double-tap tip once a hold has gone on
  `doubleTapTipHoldDuration` (20 s), shown right then, while the user is holding. One tip at a time,
  each for its display duration (2.5 s, 4 s); a tip that is used (Space) goes away at once.
- Gesture (`PushToTalkGesture`): a press released within `minimumHoldDuration` is a tap (discarded
  unseen, as before); a press within `doubleTapWindow` (400 ms) of a tap's release is `startHandsFree`:
  the overlay shows at once (no reveal delay: the double tap is deliberate). Released as a tap, the
  dictation goes on hands-free; held, it finishes on release like any hold. Hands-free, the next
  hotkey press finishes (its release does nothing), Escape cancels, Space switches the mode; the
  monitor keeps that Space and Escape from the app in front. Other keys reach the app and change
  nothing (unlike a hold, where a key means a chord and cancels). Typing between the two taps makes
  them no double tap.
- A dictation that ends without the hotkey (length cap, failure, Escape, the menu) ends hands-free
  listening: the app calls `HotkeyMonitor.dictationEnded()` on every phase past listening, so Space and
  Escape are never kept from the app while nothing listens.

**Consequences:**
- Hands-free listening is capped like a hold (`maxRecordingDuration`, 120 s since the ADR-DESK-005
  amendment of 2026-09-27, 10 minutes since ADR-DESK-049), then transcribed.
- While hands-free, Space never reaches the app: typing in the meantime loses its spaces.
- ~~A first tap is still a discarded recording start (the microphone boots and stops); a double tap
  starts it twice.~~ Superseded by the amendment below.

**Amendment 2026-09-26 (owner, after trying it):** "the double tap launches slower than just
holding"; the tip "is just too wide in a single line … a bit of a larger font … not go too much
wider than the pill itself, so it should be multi-line".
- The debug log showed why: the first audio came ~1.4 s after a double tap against ~0.6 s after a
  hold, because the first tap's release discarded its recording and the second press restarted the
  microphone. Now a tap's release (in `arming`) keeps that recording, unseen, for `doubleTapWindow`;
  a second press latches it hands-free and shows it at once (`latchHandsFree`), the microphone
  already running. With no second press it is discarded as before; a hold pressed meanwhile (after
  the gesture's window) discards it and starts afresh. The microphone is still released after
  every dictation, at most `doubleTapWindow` after a lone tap. A microphone that fails to start while a released tap waits for its
  second press is discarded unseen too; a failure after the second press shows, and a double tap
  after a failed tap starts the microphone again.
- A tip is three centered lines at 13 pt ("Press [space] to switch / between dictation / and agent
  mode"; "Double-tap [key] / to dictate / without holding"), each `tipLineHeight` tall, so its height
  is a config constant (`tipHeight`) and `opensUpward` still counts it exactly. The overlay canvas grew
  to 210 pt tall so the tip and its shadow fit under the vertically centered pill; on the screen's
  bottom lines the overlay is raised that much further above the caret.
- The double-tap tip did not show in the owner's test because it was already learned (a double tap
  came first), and the Space tip had used its 10 displays: working as decided, not a defect.

**Amendment 2026-09-27 (owner):** "when in double tap lock in mode, we should show tool tip saying
tap <hotkey> to finish dictating or tap <esc> to cancel", shown "whole time, every time"; and "the
exact text and duration, or how many times we show it, as a configurable variable that we can
change easily at a single location."
- A third tip, `handsFree`: "Tap [hotkey] to finish / dictating, or / tap [esc] to cancel". It shows
  for the whole hands-free listening, on every hands-free dictation: no display duration and no
  maximum, so it is never counted out, and nothing marks it learned. It takes the Space tip's place
  in hands-free listening (Space still switches the mode there; the Space tip still shows on holds).
  It goes when listening ends (finish, cancel, Escape, the length cap).
- Asked, the owner chose "only once truly hands-free": the tip is due when the double tap's second
  press is released as a tap (`PushToTalkGesture.Action.listenHandsFree`), not at that press. While
  the press is down no tip shows; still held once a tap is over (`minimumHoldDuration`), it is a hold
  and gets a hold's Space tip, finishing on release. A Space tip already up as a long tap ends gives
  way to the hands-free tip.
- Asked, the owner chose "above pill when opening up": in an overlay opened above the caret's line,
  a tip with no display duration (the hands-free one) goes over the pill, and over agent mode's
  bubbles when they show, its arrow pointing down (`OverlayPanelController.tipGoesAbove`,
  `hintCenter(over:bubbles:size:)`), so it never covers that line for a whole dictation. Timed tips
  stay under the pill, covering the line only briefly. The canvas grew from 210 pt to room for a tip
  and its shadow past the bubbles on each side of the centered pill (derived in `overlayCanvasSize`).
- Each tip's words, display duration and maximum displays are one `DictationConfig.TipSettings`
  (`switchModeTip`, `doubleTapTip`, `handsFreeTip`; `DictationTip.config`), replacing the four separate
  duration and count constants. Any `[key]` in a line is drawn as a keycap reading `key` (`[space]`,
  `[esc]`), and `[hotkey]` as the dictation key's (`TipTooltip.parts`); `displayDuration` nil means
  "while it applies", `maxDisplays` nil "every time". The tooltip's layout still counts on
  `tipLineCount` lines, so a tip's `lines` must keep that count.
- Ported to the Electron app (ADR-DESK-032) the same day: the `voice-hotkey` helper sends
  `listenHandsFree`; `config.switchModeTip`/`doubleTapTip`/`handsFreeTip` (`TipSettings`, null for
  nil) and `tipParts`; `tipGoesAbove`/`hintCenterOver` in `overlayGeometry.ts`, the main process
  telling the overlay page which way it opened (`OverlayState.opensUpward`, pushed on each
  placement).

**Amendment 2026-09-28 (owner: "fix the hands-free bug"):** a double tap's second press released as
a tap made the helper hands-free even when no hands-free dictation listened. That happens when the
press came while the last dictation was still transcribing or agent mode was writing (the
controller ignores it), when its dictation failed to start, or when its dictation ended while the
key was down (the menu, a lost microphone). The helper's only reset, `dictationEnded` at the end of
a dictation, had then already come before that release, so Space and Escape stayed swallowed until the next hotkey press. Now the
controller answers a `listenHandsFree` that finds nothing listening with `onNothingListening`, which
sends the helper `dictationEnded` too. The helper still goes hands-free for the moment the round
trip takes.

**Amendment 2026-09-30 (owner):** "show the press space to enter agent mode or triple tap to see
history tooltip", and the hands-free tip "should be a little bit wider, because it's now in three
lines, it looks so bad. It should just be in two lines."
- The Space tip is `agentAndHistoryTip` (ADR-DESK-043): "Press [space] for agent mode, / triple-tap
  [hotkey] for history", shown 4 s. The hands-free tip is "Tap [hotkey] to finish dictating, / or tap
  [esc] to cancel".
- A tip has at most `tipLineCount` lines; its box is as tall as its own (`tipBoxHeight`), and the
  overlay still leaves room for the tallest (`tipHeight`).

