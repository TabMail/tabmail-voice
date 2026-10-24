## ADR-DESK-006: Boot the microphone at key-down, reveal the overlay at the caret after the hold

**Context:** Owner, 2026-09-24: the app must feel instant. Measured on a Studio Display mic:
opening the input node ≈ 0.5 s and starting the device ≈ 0.5 s, and both ran on the main thread,
so the overlay appeared only after about a second or more.

**Decision:** Key-down starts the microphone on a serial queue (`.arming`, nothing shown). The
overlay appears at the text cursor once the hold reaches `minimumHoldDuration`; a shorter tap is
discarded unseen. The microphone-off half (engine, input node, tap, `prepare()`) is done ahead of
time and again after every dictation, and rebuilt when the system default input changes. The
overlay shows a gathering swirl until the first audio arrives, then a waveform pill that follows
incoming sound relative to the range coming in (`LevelEnvelope`: EMA floor and peak envelopes,
fast on their outward side, slow inward), so it follows the voice on quiet and loud mics alike
(telling speech from background is still the model's job), then a circle with a spinning rim while
transcribing. On exit it plays in reverse (the pill shrinks into the swirl, which disperses).
The overlay uses only the icon's blue → purple (but for agent mode's red-pink pill glow, ADR-DESK-036's
2026-09-29 amendment). The pill is
the surface for status now and agent responses later (as on iOS).

**Consequences:**
- The ≈ 0.5 s device start can't be hidden without keeping the mic running; speech in that
  window is lost. The swirl → pill change tells the user when audio is live. A hot-mic window is
  an owner decision (privacy indicator stays on).
- The overlay anchors to the caret, else to the focused element when it's field-sized
  (`focusedElementMaxAnchorHeight`), else to the mouse pointer. The lookup asks the frontmost app
  directly and must finish before the overlay shows, so it never appears at the pointer and then
  jumps; placeholder rects (zero origin, off every screen) are ignored. The text-marker API is
  tried before the index range (Chromium/Electron keep markers current), and a line-sized
  "caret" box (Chromium at the start of a field, terminals at a wrapped line) anchors at its
  leading edge.
- For a collapsed caret the character AT the caret is asked first and its leading edge used:
  iTerm2 answers the empty range inconsistently (the cursor cell, nothing, or a box spanning the
  cursor cell and the next row's start), which made the overlay jump between the right place,
  the pane's left edge and mid-pane. Terminals report the terminal's real cursor, which
  full-screen TUIs such as Claude Code keep on their input line. iTerm2 also drops each line's
  trailing spaces from its text but counts them in the caret index, so a caret after typed
  spaces indexes into the next line; its insertion line number stays right. A caret index off
  the insertion line is brought back to it, and one past the line's end is placed that many
  (monospace) cells right of the line-break cell.
- Gecko (Thunderbird, Firefox) and Electron apps build their accessibility tree only once an
  assistive app asks, and building takes about a second; until then Thunderbird reports the bare
  window as the focused element and the overlay falls back to the pointer. `AccessibilityActivator`
  asks each such app as it comes to the front (Gecko: `AXEnhancedUserInterface`, which it answers
  "unsupported" yet acts on; Electron: `AXManualAccessibility`), once per process, so the tree is
  ready before the user dictates. Other apps are not touched: `AXEnhancedUserInterface` has
  window-management side effects in some of them.

**Amendment 2026-09-28 — VS Code with accessibility support off.** Owner: in VS Code the overlay
opened at the start of the line, not at the cursor. Measured on VS Code 1.139 through
`voice-macos`'s `caretAnchor`: with `"editor.accessibilitySupport": "off"`, VS Code's default
EditContext input answers Accessibility with no text and the whole line's box, so no caret column
exists to read (anchor at the line's start, x 3359 where the caret was at x 3533). With the setting
at its default (`auto`, which `AXManualAccessibility` turns on) or with `"editor.editContext": false`
(the classic input sits at the caret, 1 pt wide) the anchor is exact. Anchoring at the mouse
pointer's x on the caret's line was tried and rejected by the owner. Users can't be expected to find
the setting, so the welcome wizard's Accessibility step detects it (`vscodeHidesCaret` over VS Code's
user `settings.json`, macOS only for now, where the caret is found) and offers **Fix VS Code's
Settings**, which sets `editor.editContext` false and nothing else, parsed and edited with
Microsoft's `jsonc-parser` (VS Code's own) so comments and layout are kept. `editor.editContext`
false was chosen over turning accessibility support back on because the user switched that off on
purpose. VS Code applies the change without a restart; the caret is exact from the next cursor move.
A file that doesn't parse is never offered or written. The wizard opens on first launch and from
Welcome Guide…; nothing is changed without the button. Settings › Permissions offers the same fix
(owner, 2026-09-28): a VS Code row with Fix Settings, shown only while it's needed, the section
marked for attention meanwhile. The file is rewritten in place, not through a
temporary file and a rename, so a settings file that is a symlink (dotfile managers) stays one; a
crash inside that single write could shorten it. Only the default profile's `Code/User/settings.json`
is read: VS Code profiles (`User/profiles/<id>/`), language-specific and workspace settings, VS Code
Insiders and other VS Code-based editors are not checked yet.

**Amendment 2026-09-30 — asked every time the app comes to the front, retried while it doesn't
answer.** Owner: in an Electron chat app the pill opened at the mouse pointer. The debug log showed
`AccessibilityActivator` asking the freshly launched app, which didn't answer within
`accessibilityActivationTimeout` (`kAXErrorCannotComplete`, -25204), then lookups in it with no
focused element: its tree was never built. The activator remembered the process as asked before
sending, so it never asked again and the caret stayed lost until the app restarted. An app can also
turn a built tree off again: Electron resets the mode `AXManualAccessibility` turned on once
VoiceOver goes off (`voiceOverStateChanged:`), and Chromium turns accessibility off for a page hidden
for a while. macOS has no system-wide switch a third-party app can
set to say an assistive app is running (Windows has `SPI_SETSCREENREADER`); VoiceOver's own state is
the only global signal, and it is read-only.

Now nothing is remembered between activations: each such app is asked every time it comes to the
front (asking an app whose tree is on changes nothing but Electron's `accessibility-support-changed`
event, sent again unchanged; Electron builds the tree about 2 s after the last request). An app that doesn't answer in time is asked
again every `accessibilityActivationRetryDelay`, up to `accessibilityActivationAttempts` requests,
while it stays in front; another app coming to the front stops that. Any other answer counts,
Gecko's "unsupported" included. Asking at key-down was tried and rejected: the lookup runs at once
and the pill shows at `minimumHoldDuration` (250 ms), while the tree comes a second or two after the
request, so it could only help the next dictation. A timer asking the app in front every few seconds was
rejected by the owner as needless background work.

Consequences: a tree an app turns off while it stays in front comes back the next time the app comes
to the front (switching away and back is the user's way to restart the asking); dictations until then
open at the pointer. An app that never answers within the attempts is left until it next comes to the
front.

**Amendment 2026-10-02 — the waveform turns purple once a voice is heard (owner).** "When it actually
starts to listen, the waveform color could turn from blue to a little bit more purple, our theme
color", as a sign it is listening properly, on TabMail Voice and iOS alike. TabMail Voice has no
wait for speech (a held key says someone is speaking), so the owner chose a loudness cue: the bars
are the brand blue when the pill replaces the swirl and ease (`waveformColorTransitionSeconds`,
0.4 s) to `waveformVoicedColor` (the brand purple) once a reading stands
`waveformVoiceAboveNoiseDecibels` (6 dB) above the room's noise as it stood before that reading
(`LevelEnvelope.hasVoice`: a floor of its own, left without the first `waveformVoiceWarmupReadings`
(4, ≈ 0.34 s) readings, so a start-up blip or a first reading part digital silence, which would hold
it below the room, never turns room noise purple). It stays purple for the rest of the dictation;
each dictation and each spoken answer starts a new envelope, so starts blue. Before, each bar was
the blue → purple gradient throughout.
- Loudness only (ADR-DESK-005 found no level that tells quiet speech from a room's noise): a loud
  noise turns it purple too, and a very quiet microphone's speech (2–5 dB above its noise) may leave
  it blue. Tunable in `config.ts`.
- Tests: `recorder.test.ts` › `LevelEnvelope` (just under and just over the 6 dB; no voice in room
  noise after a −70 dB blip or a part-silent first reading; speech from the first reading heard at
  its first pause); `controller.test.ts` › a voice above the room's noise turns the waveform purple
  (reset each dictation); `overlay/index.test.ts` › the waveform turns purple once a voice is heard;
  `main/index.test.ts` › the overlay is told of a voice heard and of a retry.
*(Later, owner 2026-10-02: "something that's more red and more professional", red reading as
recording, "but we don't want just pure red because that looks cheap." The
voiced colour is now a muted crimson, `waveformVoicedColor` #E5484D, in place of the brand purple;
nothing else changes. The retry circle keeps its shift toward purple, so red only ever means
recording.)*
*(Later still, owner 2026-10-02: the crimson was "a little bit too red"; from a page of candidates
the owner chose "the gray to iOS system blue". The bars are now a washed-out grey-blue,
`waveformWaitingColor` #9DB3C9, until a voice is heard, and ease to a vivid iOS system blue,
`waveformVoicedColor` #0A84FF: a washed-out colour while not recording that becomes vibrant once it
is. Nothing else changes; the retry circle keeps its shift toward purple.)*

**Amendment 2026-10-09 — a voice is told in its band, against the room the last dictation left
(owner).** "Even when the audio seems to be recording in the voice app, the waveform turns blue often
quite late." Measured on `Scripts/stt-compare`'s ten recordings and the last dictation kept: the old
detector never turned four of them blue and took about 5 s on two. Two causes: the microphone's first
audio comes about 0.58 s after the key (the app log, every dictation), so speech often comes with it,
and the room's noise (a running average over its first seconds) was learned from the voice and
heard only after the first pause; and over the full band a room's low hum leaves speech only 2–5 dB
above the room, under the 6 dB. The owner chose, of three options, both fixes:
- A voice is told in the voice band (`VoiceBand`: second-order Butterworth high-pass at
  `voiceBandLowHertz` 300 Hz and low-pass at `voiceBandHighHertz` 3,400 Hz, telephone speech's
  band); `LevelSampler` reports each interval's loudness and its voice band's. The bars still move
  with the full band. In the band, speech stands 8–14 dB above the room (10th to 90th percentile of
  the readings) against 5–10 dB over the full band.
- The room's noise in that band is a floor (down fast, up slowly, `envelopeFastAlpha` and
  `envelopeSlowAlpha`), no longer a running average at first, skipping digital silence, and each
  dictation or spoken answer's envelope starts from the room the last one left (`LevelEnvelope.room`,
  in memory only, a single number; the app forgets it when it quits). The warm-up readings are still
  skipped.
- Measured, the same recordings in a row: all turn blue 0.43–0.68 s after audio starts; the first
  dictation after launch, with no room yet, 0.68–3.3 s.
- Trade-off the owner accepted: right after a switch to a much louder microphone or room, the next
  dictation can turn blue on the room's noise, until the floor moves down to it.

**Amendment 2026-10-20 (owner): the listening pill is the circle's height.** The owner saw agent
mode's bubbles and the chat window move up and down as the pill turned from the waveform into the
circle and back. The listening pill was 30 points tall (the 18-point waveform, 5 points of padding
over and under it and the border; `listeningPillHeight` left the border out and said 28), the circle
26, and the pill's top stays put, so all under it moved 4 points; its padding over and under the
waveform also sprang past its mark on each change, which made it wobble too. Chosen from an animated
page of three sizes: the waveform stays as it was, and the pill behind it is the circle's 26 points
(`pillHeight`; `listeningPillHeight` is gone), the waveform centered in it with no padding over or
under it, so only the width changes; its ends 2 points closer to the waveform as its top and bottom
came (`listeningPillHorizontalPadding`, 12; a message keeps `pillHorizontalPadding`), and the
language badge still concentric with its rounded end (`languageBadgeInset`, inside the border). The
preview checks every listening, thinking and working pill is `pillHeight` tall as laid out.

