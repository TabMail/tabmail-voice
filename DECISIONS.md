# TabMail Voice — Decisions

Compact index of architectural decisions for `tabmail-voice` (the TabMail Voice app). Cross-cutting decisions live in the
root `DECISIONS.md` (notably ADR-004 zero content retention, which dictation audio and transcripts
fall under).

---

## ADR-DESK-001: Native Swift menu-bar app, on-device speech recognition

> ⛔ **Speech-recognition half SUPERSEDED by ADR-DESK-005 (owner 2026-09-24).** The native Swift menu-bar app stands; on-device `SpeechAnalyzer` was removed in favor of backend STT so all platforms share one engine. Kept for history.
>
> ⛔ **Native-Swift half SUPERSEDED by ADR-DESK-032 (owner 2026-09-27):** one Electron app for macOS, Windows and Linux replaces the Swift app; `apps/macos/` was removed 2026-09-27 (ADR-DESK-032's cutover amendment). Kept for history.

**Context:** Phase 1 replaces Wispr Flow for basic system-wide dictation. Options: Electron/Tauri
(cross-platform) or native Swift; cloud STT (Groq Whisper via the backend) or on-device.

**Decision:** Native Swift/SwiftUI menu-bar app (`LSUIElement`), macOS 26+. Speech is transcribed
on-device with `SpeechAnalyzer` + `DictationTranscriber` (`.progressiveLongDictation`, punctuated).

**Rationale:** Global hotkeys, Accessibility, keystroke posting and audio are all first-class in
AppKit; the team already ships Swift (iOS) and can share code in phase 4. On-device STT costs
nothing per minute, needs no account, sends no audio anywhere (ADR-004 by construction), and
`AnalysisContext.contextualStrings` gives phase 2 a private way to bias recognition towards names
from mail and calendar. Verified end-to-end by `SpeechTranscriptionSessionTests`.

**Consequences:**
- macOS only; Windows would be a separate client.
- Accuracy is Apple's model's. If it proves insufficient against Wispr Flow, a server STT
  endpoint (Groq `whisper-large-v3-turbo` through the TabMail backend) is the escalation. That
  sends audio off-device, so it's the owner's call.
- First use of a language downloads its model (`AssetInventory`); the app does this at launch.

## ADR-DESK-002: Insert by pasting, then restore the clipboard

**Context:** Dictated text must land in any focused field: native, Electron, browser, terminal.

**Decision:** Write the text to the general pasteboard (marked `org.nspasteboard.TransientType` /
`ConcealedType`), post ⌘V, wait `DictationConfig.clipboardRestoreDelay`, then restore every item
and type of the prior clipboard, unless the pasteboard changed meanwhile.

**Rationale:** Setting `kAXSelectedTextAttribute` silently fails in most web views and Electron
apps; synthesizing per-character key events is slow and breaks on non-ASCII text. Pasting is what
Wispr Flow and similar tools do.

**Consequences:** A clipboard manager that ignores the transient markers may record the text.
Apps that read the pasteboard lazily after the restore delay would paste the old clipboard; the
delay is a config value to tune if that's seen.

## ADR-DESK-003: Not sandboxed; Developer ID distribution

**Context:** The global hotkey (`NSEvent` global monitors) and ⌘V posting both need Accessibility,
which the App Sandbox forbids.

**Decision:** No App Sandbox; hardened runtime with the `audio-input` entitlement. Distribute as a
Developer ID-signed, notarized app outside the Mac App Store.

**Consequences:** No Mac App Store listing. TCC grants are bound to the code signature, so
development builds must be signed with a stable team (`DEVELOPMENT_TEAM` in the gitignored `Secrets.xcconfig`, as in tabmail-ios), or Accessibility
is lost on every rebuild.

## ADR-DESK-004: Phase 1 needs no account and no backend

> ⛔ **SUPERSEDED by ADR-DESK-005 (2026-09-24):** server STT makes sign-in a phase-1 requirement. Kept for history.

**Context:** Phase 1 is "dictation anywhere, nothing complicated".

**Decision:** Phase 1 ships without TabMail sign-in or backend calls. Sign-in (Supabase, mirroring
iOS `TabMailAuthService`) arrives with the first backend feature: AI cleanup in phase 1b or phase 2.

**Consequences:** Adding backend features later requires the backend to recognize a `desktop`
client type.

## ADR-DESK-005: Speech-to-text on the TabMail backend (OpenRouter), shared by all platforms

**Context:** Owner, 2026-09-24: dictation should use an OpenRouter speech-to-text model via our
backend, so the same engine serves desktop, iOS and Thunderbird later.

**Decision:** The app records 16 kHz mono 16-bit PCM (`AudioRecorder`), wraps it in WAV
(`WAVEncoder`; FLAC since ADR-DESK-039) and posts it as base64 JSON to the TabMail backend's `POST /dictation/transcribe`,
which relays it to an OpenRouter speech-to-text model. Requires TabMail sign-in (email one-time
code, same flow as iOS) and an active subscription; dictation counts toward the account's usage.

**Rationale:** One engine and one model switch (backend config) for every client; far better
multilingual accuracy than Apple's on-device model.

**Consequences:**
- Audio leaves the Mac. The TabMail backend stores and logs neither audio nor text.
- No live transcript while speaking (batch upload on release); latency ≈ upload + model time.
- Every held recording is uploaded; an empty transcript shows "Didn't catch that." There is no
  loudness gate: on a Studio Display mic, speech measured only 3–10 dB above the room noise
  (−30 to −40 dB RMS against about −45 dB), so the earlier fixed −32 dB gate rejected nearly
  all real speech, and a gate relative to the noise floor couldn't separate a quiet sentence
  from silence either. The model, chosen by comparison with `Scripts/stt-compare/`, handles
  that input. Recording continues `releaseTailDuration` after the key is released so the last
  word isn't clipped.
- ~~Recording auto-stops at `maxRecordingDuration` (5 min ≈ 9.6 MB, under the backend's 10 MiB upload limit).~~
  Superseded 2026-09-27: auto-stops at 120 s, below.
- A failed transcription loses that recording (no retry queue yet). (Since ADR-DESK-039 a server
  error or dropped connection is retried twice before it does.) Chunking long dictations
  (transcribe ~20–30 s pieces as they complete, retry a failed piece alone) is tracked in
  issue #1 (P3).
- macOS 15+ (the macOS 26 floor existed only for `SpeechAnalyzer`).

**Amendment 2026-09-27 — the length cap is 120 s.** Owner: *"there was a bug before about this
recording limit being five minutes instead of just two, which is the 120 second limit that fits the
back end… we should do it for two minutes for now until the chunking arrives in the back end."* The
5-minute cap fitted the backend's 10 MiB upload limit, but the backend's transcription model takes
at most 120 s of audio (backend ADR-022), so a longer recording was uploaded only to fail.
`maxRecordingDuration` is 120 s in both apps (`DictationConfig`, `config.ts`), for a hold and
hands-free alike; the recorder keeps nothing past it. Raise it once chunking (issue #1) lands.

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

## ADR-DESK-007: Screen context from the Accessibility tree, not screen pixels (phase 2 prototype)

**Context:** Phase 2 gives dictation the context on screen. Measured on one Mac (2026-09-25): the
Accessibility tree of the focused window gives structured, visible text in Chrome, Safari,
Firefox, Slack, Notion, Cursor, Codex, Calendar, Messages and Thunderbird in 0.2–1.5 s; Vision
OCR of a 5K screen takes 0.8 s (fast) to 5 s (accurate), yields flat lines with no structure,
and needs the Screen Recording permission.

**Decision:** Read the Accessibility tree we already hold the permission for. At key-down the
frontmost app's focused window is walked in child order (reading order) within a node and time
budget, skipping interface chrome (buttons, menus, toolbars, images) and anything outside the
window. Headings, links and table rows become one block each. The focused field becomes a caret
block at its place in that order, its text marked at the caret; its ancestors are never
collapsed or pruned so the walk reaches it. The page host comes from the nearest web area above
the caret. Web editors report the caret as a text-marker range, so markers are read first, then
the field's value and selected range. Terminals under tmux are read from tmux (`capture-pane` of
the most recently active client's pane, cursor from tmux, foreground process of its tty); the
terminal's own text is every pane side by side and iTerm2's caret index drifts.

**Consequences:**
- Prototype only: wired in Debug builds; the latest capture is kept in memory and shown in a
  debug window. Logs carry sizes and timings, never text. Nothing is stored or sent.
  ⛔ Superseded by ADR-DESK-008 (2026-09-25): captured in every build and sent with the transcript
  for the cleanup. Still never logged or stored. *(Amended by ADR-DESK-015, 2026-09-26: debug builds
  log it in full to the local debug log file.)*
- A plain terminal tab without tmux gets its visible lines but no caret mark or program.
- The tmux pane is the most recently active client's, and is used only when most of its last
  lines appear in the front terminal's text; a tmux attached in another tab or window is ignored.
- OCR stays a possible later fallback for apps whose tree is thin, as an owner decision.
- *(Amended by ADR-DESK-016, 2026-09-26: the visible text is laid out in lines from the elements'
  frames, web controls and toolbars are read, and text in point-thin boxes is left out.)*
- *(Amended 2026-09-30, owner: a password field (`kAXSecureTextFieldSubrole`) is never read, focused
  or not, nor anything inside it, as correction learning already does (ADR-DESK-038). The read no
  longer relies on the app hiding the field's value; the focused one still gets its caret block,
  empty. A password an app shows in an ordinary field or as text is still read: excluding apps is
  issue #5.)*
- *(Amended 2026-10-01: the refusal comes before anything is asked of the field. A focused password
  field is given neither to the terminal's pane reader nor to the caret read, and the field read for
  correction learning asks for its subrole before its value and never asks a password field for
  one.)*

## ADR-DESK-008: Clean up every transcript with the screen context, on the backend

**Context:** Owner, 2026-09-25: after transcription, a language-model pass should fix dictation
errors using what is on screen, with the smallest possible changes. The instructions and the
model choice live on the backend, so they can be edited and switched there without an app release.

**Decision:** The screen context (ADR-DESK-007) is captured at key-down in every build. When the
transcript arrives, the app waits up to `contextWait` (0.5 s) for that capture and sends the transcript with the app name,
web host, terminal program, window title and the visible text (caret marked) to the backend's
`POST /completions/chat` as the prompt `system_prompt_dictate_cleanup`, then pastes the reply.
*(Amended 2026-09-26, owner: the cleanup also removes filler words and accidentally repeated
words and corrects grammar, still changing nothing else. It is a backend prompt change, edited in
place in `v0.1.0` because the app's version line is `0.1.0`; no app change.)*
Request shape and server-sent-events parsing follow iOS `BackendClient`, with two deliberate
differences: the app fails the cleanup on an `event: error` (iOS logs it and waits for `final`),
and it accepts only HTTP 200 (iOS accepts any 2xx). The backend never sends both `error` and
`final`, and answers 200, so neither changes an outcome today.

**Consequences:**
- What is on screen while dictating is sent to the TabMail backend with each dictation; like every
  TabMail AI request it is not retained (root ADR-004), and the app logs sizes only. *(Amended by
  ADR-DESK-015, 2026-09-26: debug builds log the text in full to the local debug log file.)*
- Every dictation gains one model round trip; its duration is logged (debug) for tuning. Owner,
  2026-09-25: the cleanup is capped at `cleanupTimeout` (3 s; the owner asked for 2–3 s); past it
  the request is canceled and the transcript is pasted as heard, like any other failed cleanup.
- ~~A failed or empty cleanup fails the dictation with an error; the raw transcript is not pasted
  instead (no fallback without an owner decision).~~ Owner, 2026-09-25: when the cleanup fails
  for any reason (error, refusal, empty reply, offline, signed out), the transcript is pasted as
  heard. A failed cleanup never costs the user the dictation; the failure is logged (type only).
- The app sends its own version (`0.x`) as `X-Client-Version`; a backend prompt it uses must be
  versioned to resolve at that version.
- A dictation's transcription and cleanup go under the account signed in when its upload starts.
  If the user signs out and into another account meanwhile, the cleanup is skipped and the
  transcript pasted as heard (`DictationController.withFreshToken` refuses a token for another
  account).
- ~~The cleanup waits for the capture, so the capture must finish.~~ Owner, 2026-09-25: the
  capture runs in parallel and is best effort. If it is not done within `contextWait` of the
  transcript arriving, the cleanup runs without it and the capture is forgotten (an Accessibility
  read of an unresponsive app can take seconds). Each helper command (tmux, ps) still gets
  `contextCommandTimeout` and is stopped after it, so an abandoned capture does not leave a
  process behind: a stopped tmux server keeps its client's output open, so waiting for the end of
  the output alone could hang.
- Owner, 2026-09-25: screen reading is switchable (ADR-DESK-010). With it off, nothing is read
  and the cleanup runs without screen context.
- The screen text is untrusted input to the model: text on screen, such as terminal output someone
  else wrote, can steer the reply that gets pasted (prompt injection into the paste), including a
  reply with a line break that a terminal without bracketed paste would run as a command. Owner,
  2026-09-25: not a risk for dictation; no guard. The reply is only trimmed of surrounding blank
  space before it is pasted.

**Amendment 2026-09-28 — only the text around the caret, and a 1.5 s cap.** Owner: the cleanup
"doesn't really need to be that heavy"; "8K characters is useless ... only a brief capture text
should go for the cleanup. The full screen content should only be available for the agent". Measured
over 133 dictations in a debug log: release to paste took a median 1.7 s, of which the cleanup's round
trip was a median 0.75 s (0.97 s with more than 8k characters of screen text), and one timed out at
3 s with about 4k characters. The cleanup now gets, as `screen_text`, only the rendered screen within
`cleanupContextBefore` (500) code units before the caret and `cleanupContextAfter` (200) after it,
cut between characters, markers as rendered (`textAroundCaret`). The caret is the marker on the
focused field's `» ` lines; with no field holding the caret, the cleanup gets no screen text. Agent
mode's tools still get the whole screen. `cleanupTimeout` is 1.5 s (was 3 s); past it the transcript
is pasted as heard, as before. The backend prompt's wording ("the window's visible text") is
unchanged; the excerpt keeps its markers.

**Amendment 2026-09-29 — the cleanup runs in the transcription request.** Owner: the cleanup
"is always done", so the app sends "all the cleanup related information" with the recording and the
backend "calls the transcriber and the cleanup all together on one go"; the cleanup deadline stays and
"it should be the backend that enforces it". A dictation now makes one request,
`POST /dictation/transcribe` with a `cleanup` block (`DictationCleanup.variables`: app name, web host,
terminal program, window title, the text around the caret and the dictionary, one word per line), and
gets `{ text, cleaned_text }` back (backend ADR-027). The second authorization, quota and throttle pass
the cleanup's own request paid, and its round trip, are gone. The app pastes `cleaned_text`, or the
transcript as heard when it is empty (the backend's cleanup failed, was refused or ran past its 1.5 s
deadline) or absent (a backend from before this change) (`DictationCleanup.pasted`). The app's own
`cleanupTimeout` is gone; the request's `transcriptionRequestTimeout` covers both. Consequences:
- The screen read must be done by the upload, since its text goes with the recording: the upload
  waits up to `contextWait` for it (it was the transcript's arrival). The read starts at key-down, so
  it is usually done; one that is not goes out empty, as before. The recording's screen terms
  (ADR-DESK-038) see a read done in that wait too.
- Transcription and cleanup share one token: an account switch during the request sends nothing
  under the other account and pastes that request's cleanup (both ran under the account signed in at
  the upload, as this ADR required).
- Agent mode's transcription sends no `cleanup` and is unchanged.
- Every field is cut to the backend's per-field limit (`config.cleanupFieldMaxLength`, 20,000 UTF-16
  code units, its `cleanup.maxFieldChars`), its start kept, between characters. Over the limit the
  backend refuses the whole request, the transcription included, and a window title is whatever the
  app or web page sets. The cut bounds the cleanup model's input only.

**Amendment 2026-09-28 (later) — never no screen for want of the marker; no selection.** Owner: "we
should not have empty screen just because we can't find the correct character"; "if we are able to
find the line where the character is ... including that line in the context"; and "when simply
dictating i think that selected text should not even go through". In the owner's debug log the helper
placed no marker in almost every terminal capture without tmux (the terminal's lines are kept as a plain
field) and in about half the captures of one chat app (the walk hit its time budget before the field). `placeCaret` now puts one caret
marker in the screen text, in order: the helper's marker on the `» ` lines; else on the caret's line as
the helper read it around the caret (`textBeforeCaret` to its last line break, the selection as the
screen still shows it, `textAfterCaret` to its first line break, trailing blanks dropped), found as
whole `> ` field lines, the last such on screen, the selection then cut from the screen (a terminal
without tmux renders its lines so; the caret's text inside a word, a longer line or a page line is not
its line); else after the screen, the helper's text
around the caret rendered as a focused field (`» ` lines). The excerpt is then cut around that marker as
before; the screen text is empty only without a screen read. A selection is left out wherever the caret
is placed: the dictation replaces it, so the cleanup gets the caret alone, and the reach before and after
counts no selected text. A caret line that is also another whole field line lower on screen places
the marker there; the owner asked for the line search.

## ADR-DESK-009: The app identifies itself to the backend as `macos`

**Context:** Owner, 2026-09-25: the platform the Mac app reports should be called macOS, and the
admin panel should show it.

**Decision:** `X-Client-Type` is `macos` (was `desktop`). The admin panel counts `macos` usage as
its own device, beside Thunderbird and iOS.

**Consequences:**
- The backend reads the Thunderbird prompts for any client type other than `ios`, so prompt and
  tool resolution are unchanged.
- Usage recorded under `desktop` during development (2026-09-24 and 25) keeps that label.

## ADR-DESK-010: A welcome wizard for consent, permissions and features; screen reading switchable

**Context:** Owner, 2026-09-25: the Mac app needs an onboarding wizard like the Thunderbird
one, covering (1) consent, (2) permissions and (3) feature toggles, starting with screen
reading. Until now, screen reading ran on every dictation whenever Accessibility was granted,
with no setting. At every launch the app asked for any missing Microphone and Accessibility
grants. The privacy policy tells users they can switch screen reading off.

**Decision:**
- **Layout.** The wizard copies the Thunderbird welcome wizard's layout:
  - a top rail of category labels, with one bubble per step;
  - Back and Next buttons, with Finish on the last step;
  - bubbles that return only to steps already reached.
- **Steps.** Consent → About You (the user's name, ADR-DESK-035) → Permissions (Microphone,
  Accessibility) → Features (screen reading).
- **Consent step.** It says what dictation sends: the voice, and the text in the front window
  while screen reading is on. It says where that goes (TabMail and its AI providers, not stored)
  and links the Terms of Service and the Privacy Policy. Next stays disabled until the user
  ticks the agreement.
- **Consent gates dictation.** A key-down without consent records nothing, reads no screen,
  sends nothing and says why. Consent is checked at key-down only: a dictation started with
  consent is still sent if the user withdraws consent before it ends, and the next key-down is
  refused. The owner chose this over re-checking before each request because it is the simpler
  code (2026-09-25). The menu's Stop stays enabled while recording, so a recording can always
  be stopped.
- **Permission and feature steps** never block Next.
- **Screen reading** (`AppSettings.readsScreen`) is on by default, since the consent step
  discloses it. It is read at every key-down with the other settings (ADR-DESK-017), so a change
  applies from the next dictation. It can also be switched in Settings.
- **When the wizard opens.** It opens at every launch until the user presses Finish; closing the
  window doesn't count. It can be reopened from the menu (Welcome Guide…).
- **Replaces the launch-time permission prompts.** The app no longer asks for permissions at
  launch; it only polls for the Accessibility grant, so a grant made in System Settings takes
  effect without a relaunch.

**Consequences:**
- Existing installs see the wizard at their next launch. They can't dictate until they consent.
- Consent, the screen-reading choice and "finished" are stored on this Mac (UserDefaults), not
  on the account. The consent isn't versioned; changing what dictation sends means re-asking,
  which is a new decision.
- A grant made from the wizard is announced by `PermissionsModel`. The Microphone grant is
  announced once the model already reports it. A Microphone grant prepares the microphone for
  the first dictation. An Accessibility grant re-installs the hotkey.
- **Open (owner):** per-app exclusion. It could be a denylist in the Features step or a built-in
  skip list. Web search and web reading get their own toggles in Features once they exist.


## ADR-DESK-011: Agent mode on a double tap: the agent chooses a tool, the tool writes the text

> **Amended 2026-09-26 (owner):** the double tap is replaced by **Space during the hold**, the
> selection alone picks Edit or Compose, the bubbles sit still in a row above the pill, and agent mode has no
> timeout. See "Amendment 2026-09-26" at the end of this ADR; the gesture, tool-choice, wait and
> timeout bullets below are superseded where it says so.
>
> **Later (ADR-DESK-021):** the Space hint became a tip that retires once learned, and a double tap is
> back, for hands-free dictation (not agent mode).
>
> **Later (ADR-DESK-042):** the "You switched apps, so nothing was pasted" check is gone: every paste
> goes where the caret was at key-down, or onto the clipboard and into the paste history. Amended the
> same day: only the app is checked, for dictation and agent mode alike (`focusChanged`), and a text
> for another app goes onto the clipboard and into the paste history instead of failing.

**Context:** Owner, 2026-09-25: a double tap of the hotkey enters agent mode. Speech is then a
request to carry out, not text to insert. The first tools are **Edit** (rewrite the selected text
as asked, like Thunderbird's inline editor) and **Compose** (write new text at the caret, for any
app, not only mail). Their bubbles show around the pill (owner, 2026-09-26: they float around it
and wiggle a little, "not too much": left, under and right of it, over it when the pill sits above
the caret, so none covers the caret's line); after the request, the chosen tool's
bubble border circles while it runs. The prompts are the desktop's own, reusable by any later
desktop platform, not the Thunderbird email prompts.

**Decision:**
- Gesture (`PushToTalkGesture`): a press released within `minimumHoldDuration` is a tap. A press
  within `doubleTapWindow` of a tap's release starts agent mode. Held, it finishes on release
  like a dictation; tapped, agent mode listens hands-free until the next press. Typing cancels,
  as during a hold. Both readings of "double tap" work, so neither had to be ruled out.
- Two backend calls, both `POST /completions/chat` template prompts in the backend's `common/`
  registry at v0.1.0 (backend ADR-023). `system_prompt_desktop_agent` (light tier) chooses the
  tool from the request, the selection, the app and the window title, and answers `Tool: edit` or
  `Tool: compose`. The phase becomes `running(tool)` and the tool's prompt
  (`system_prompt_desktop_edit` / `_compose`, heaviest_fast tier) writes the text from the request
  and the screen context. Separate calls let the bubble show the chosen tool while it works, and
  each tool gets a prompt of its own.
- Edit pastes over the selection, which the non-activating overlay leaves in place; the result
  keeps the selection's own leading and trailing blank space (a selected line keeps its line
  break). Compose pastes at the caret; with text selected it first collapses the selection to its
  end (→), so the selected text stays.
- The selection is the one the key-down screen read (ADR-DESK-007) found. Agent mode waits
  `agentContextWait` (2 s) for that read, not the dictation's 0.5 s: an edit cannot work without
  it.
- A failed request pastes nothing and says why: no known tool, an edit with nothing selected, an
  empty text, a timeout (`agentChooseTimeout`, `agentToolTimeout`) or a backend error. Unlike the
  dictation cleanup, there is no "paste as heard": the spoken request is not text for the document.

**Consequences:**
- Agent mode adds a model round trip before the tool runs (light tier, reasoning off).
- No client-side tools: the Mac app at 0.1.0 would read Thunderbird's tool registry, and a
  desktop tool listed there would reach Thunderbird's agent too. *(Later (ADR-DESK-023): the app has
  its own `macos` registry, and the Answer prompt calls tools that run on the user's computer.)* The later Thunderbird connector
  follows the same tool-choice contract (a third tool name; ADR-DESK-014).
- Apps whose accessibility tree hides the selection (thin trees, some Electron apps) can't be
  edited; the request fails with "Select the text to edit". Copying the selection with ⌘C
  instead would be a fallback: an owner decision.
- With screen reading switched off (ADR-DESK-010), there's no selection, so Edit never runs.
  Whether Edit reads the selection anyway is an owner decision.
- The selected text and the screen are sent to the backend with the request; nothing is stored
  (root ADR-004). The prompts treat both as content, never as instructions.

**Amendment 2026-09-26 (owner):** "I dislike the double tap"; Edit or Compose "should depend
exactly on … whether we have selected text or not, and … only either of the 2 icons should show";
the bubbles wiggled too much ("appearing alongside looks okay"); "agent should not have timeout".
- Gesture: every hold starts as a dictation; **Space during the hold** switches between dictation and
  agent mode (`PushToTalkGesture.Action.toggleMode`), any number of times; other keys still cancel.
  `HotkeyMonitor` is now a `CGEventTap` (Accessibility, as before) so that Space, its auto-repeat
  and its key-up are kept from the app in front; a key monitor can only observe. The double tap,
  hands-free listening and `doubleTapWindow` are gone. While the pill listens, a hint under it (over
  it when the overlay opens upward) says "Space to toggle agent mode" / "Space to disable agent mode";
  later the same day made quieter at the owner's request: a small "space" keycap with "agent mode" /
  "exit agent", no border. Later again (owner: "a tooltip that appears below the middle and
  disappears after a little"): a tooltip centered under the pill, with an arrow up at it, always
  below (even when the overlay opens upward, since it is brief), fading after
  `modeHintDisplayDuration` (2.5 s), once a hold. Then styled as a system tooltip (owner: the light
  one "looks cheap … almost a black background"): a near-black rounded box with a hairline border
  and a soft shadow, white text, a raised "space" keycap, the arrow part of the same outline.
  The overlay opens below the caret's line only when the listening pill and the hint under it both
  fit on screen there (`opensUpward` counts the hint's `modeHintFootprint` and the listening pill's
  real height, `listeningPillHeight`); otherwise the hint's lower half went off the bottom of the
  screen for a caret a line or two above it. Opened above a caret on the screen's bottom line, the
  overlay is raised as far as the hint under the pill needs to stay on screen.
- Tools: Edit when the key-down screen read found selected text, Compose when not
  (`DesktopAgent.writingTool`); never both. No bubble shows until that read is done, and agent mode
  waits for the whole read (no `agentContextWait`), so the tool that runs is the one shown. The agent
  prompt now only decides whether a request goes to the email app (ADR-DESK-014): it is not called
  when there is none, and its pick of the other writing tool gives way to the selection's.
  Consequently "Select the text to edit" and "Compose after the selection" (→ collapse) are gone: a
  selection always means Edit.
- No deadline on agent calls: `agentChooseTimeout`, `agentToolTimeout` and `Failure.timedOut` are
  removed. The completions request keeps its idle timeout (`completionsRequestTimeout`, a pause
  between stream bytes; the backend sends keepalives), which is a dead-connection check, not a cap.
- Bubbles sit level with the pill, first to its right, then its left, with no drift (later the same
  day, owner: "appear on top … like a list on top": one row centered above the pill; the hint then
  went over the whole stack when the overlay opened upward, until it became the tooltip above); they are icon-only circles (20 pt, 13 pt app icon, 10 pt symbol): with one writing tool shown, the name
  adds nothing (owner). The name stays as the accessibility label. Owner, later the same day: small
  but slightly larger (now 24 pt, 16 pt app icon, 12 pt symbol), and the running tool's bubble grows
  further, "sort of like a genie effect", so the tool in use is obvious: it springs up to 1.4× from its
  bottom edge, away from the pill, with a little overshoot (`agentBubbleRunningScale`).
- The "sometimes works" failures the owner saw were not timeouts: the dev backend log showed the
  agent model drafting text after `Tool: compose`, and the edit/compose model continuing the lone
  system message (`</request>`) or answering empty. Fixed in the backend (ADR-023 amendment: the
  request is the final user turn, and the agent's first word after `Tool:` counts).
- With no deadline, the user may move to another app before the text arrives. Edit and Compose paste
  only while the app that was in front at key-down still is; otherwise the request fails with "You
  switched apps, so nothing was pasted" (`DesktopAgent.Failure.appChanged`, 2026-09-26 review). The
  Thunderbird tool is exempt: it brings Thunderbird to the front itself, and has its own focus checks.

## ADR-DESK-012: The app is TabMail Voice (`ai.tabmail.voice`)

**Context:** Owner, 2026-09-25. The app built as `TabMail.app` (bundle id `ai.tabmail.desktop`). The
Thunderbird installer's pkg installs
`/Applications/TabMail.app` too: the launcher that starts Thunderbird, carrying `tabmail.xpi` and
the native-fts `fts_helper`, which `tabmail-native-fts` looks for at that path. Dragging this app into
`/Applications` would replace the launcher and break Thunderbird's local search. "Tabby" was ruled out
(an app by that name exists).

**Decision:** The app is **TabMail Voice**: `PRODUCT_NAME` and `CFBundleDisplayName` "TabMail Voice"
(`TabMail Voice.app`), module `TabMailVoice`, bundle id `ai.tabmail.voice` (tests
`ai.tabmail.voice.tests`). The code moves with it: `TabMailVoice/`, `TabMailVoiceTests/`,
`TabMailVoice.xcodeproj`, targets and scheme `TabMailVoice` / `TabMailVoiceTests`, `TabMailVoiceApp`.
The log subsystem, queue labels and Keychain service use the new id. Text that names the app says
"TabMail Voice"; text that means the service or the account (sign in, subscription, "sent to
TabMail") still says "TabMail". The repository stayed `tabmail-macos` at first;
renamed `tabmail-voice` on 2026-09-26 (owner), see ADR-DESK-013.

**Consequences:**
- A new bundle id is a new app to macOS: Microphone and Accessibility are asked for again (the
  welcome wizard, ADR-DESK-010, walks through them), the saved sign-in is not found (service
  `ai.tabmail.voice.session`), and settings start fresh. Grants for the old id stay in System
  Settings until removed (`tccutil reset All ai.tabmail.desktop`).
- Automatic signing covers the new id with no portal change while the app uses no capability
  that needs a provisioning profile; Developer ID distribution needs no App ID of its own.
- Earlier decisions keep the name they were written under ("TabMail Desktop", `ai.tabmail.desktop`)
  where they describe history.

## ADR-DESK-013: One repository for TabMail Voice on every platform, one folder per platform

> ⚠️ **Amended by ADR-DESK-032 (owner 2026-09-27):** the platforms share one Electron app, `apps/desktop/`, not a native app each; `apps/macos/` was deleted at cutover (2026-09-27), with `Scripts/copy-worktree-secrets.sh` and the signing-config template.

**Context:** Owner, 2026-09-25: the repository will be renamed `tabmail-voice` on GitHub, with the
macOS app in a folder of its own so that other platforms (Windows, Linux) can follow. The layout
follows the OpenClaw reference (`references/openclaw/apps/{macos,ios,android,shared}`): each
platform is a native app in `apps/<platform>/`, and shared code is a package in `apps/shared/`
used only by apps in the same language (there, Swift for the Apple apps; Android is separate
Kotlin).

**Decision:** The macOS app, its XcodeGen spec and `xcodegen.sh` live in `apps/macos/`. Repository-wide
files stay at the root: the docs, `Scripts/copy-worktree-secrets.sh`, `Scripts/stt-compare/` (backend
speech-to-text comparison, platform-free), and the gitignored signing config with its template.
The signing config stays at the root so the worktree helper and every existing checkout keep
their copy where it is; `project.yml` reads it as `../../`.

**Consequences:**
- Commands run from the repository root with `apps/macos/` paths; each worktree's DerivedData is
  `apps/macos/DerivedData`.
- No shared package yet. Most of the app is platform-specific (hotkey, microphone, Accessibility
  reading, paste, overlay), and the intelligence (transcription, cleanup, agent prompts) is on the
  backend, which is already shared. When a second app needs the platform-free parts (gesture
  recognizer, dictation and agent flow, backend clients, WAV encoding), they move into
  `apps/shared/` as a Swift package, if that app is Swift; otherwise the second app shares the
  backend contract and test vectors, not code.
- The GitHub rename and the local folder rename (`tabmail-macos` → `tabmail-voice`) are separate
  steps, after the open branches merge. Done 2026-09-26 at the owner's request, before they merged:
  `TabMail/tabmail-voice` on GitHub (the old URL redirects), the primary checkout at
  `tabmail-voice/`, worktrees re-attached with `git worktree repair`.

## ADR-DESK-014: Thunderbird connector spike: drive TabMail's chat from outside

**Context:** Owner, 2026-09-25: agent mode's bubbles become the supported apps, starting with
Thunderbird; any mail or calendar request goes to TabMail's chat in Thunderbird. Nothing outside
Thunderbird can reach the add-on today (no external messaging, no URL scheme, native messaging is
request/response). The owner chose a spike with no Thunderbird change before building a bridge,
the agent restating the request as a chat message, and sending being enough (no reply back).

**Decision:**
- A third tool, `thunderbird` (backend `system_prompt_desktop_thunderbird`, ADR-023), offered, and
  shown as a bubble with the email app's own icon, only when there is an email app for it. The agent's
  prompt always names it; the app fails a request given to a tool it did not offer ("Mail and
  calendar requests need Thunderbird with TabMail"). *(2026-09-26, ADR-DESK-011 amendment: without an
  email app the agent is not asked at all, so that failure no longer exists.)*
- `ThunderbirdRelay` sends the chat message: launch Thunderbird if it isn't running (then wait for a
  window and `thunderbirdAddonSettle` for the add-on), bring it to the front through Accessibility
  (`AXFrontmost`: the app is never active, so cooperative activation would ignore
  `NSRunningApplication.activate`), post the add-on's ⌥⌘L unless the focused window is already
  the chat, wait for a window titled "TabMail Chat", paste, press Return.
- The email app (owner, 2026-09-26: "configurable in settings (which email client) default to user
  default email client") is the one chosen in Settings › Agent mode, else the default email app
  (the `mailto:` handler) if it is a Thunderbird TabMail runs in: Thunderbird (release and ESR share
  `org.mozilla.thunderbird`) or Thunderbird Beta (`org.mozilla.thunderbirdbeta`, the add-on's dev
  instance). Any other default email app leaves the tool out until a Thunderbird is chosen.
  `EmailClient` resolves it at every call, so a change applies to the next request.
- Nothing is typed outside the chat: the shortcut is posted only while Thunderbird is in front, the
  paste only while the chat window has focus (checked again after the input settles), and Return
  only if it still has focus after the paste. Any failure shows a message.

**Consequences:**
- Known weak points, for the spike to measure: a chat that is mid-reply ignores Enter (the message
  stays in the input); the add-on registers ⌥⌘L lazily, so a suspended background page may miss
  it; a remapped shortcut breaks it; the app cannot tell whether the add-on is installed (the chat
  just never opens); cold-launch timing is a guess.
- The native-messaging bridge (plan option B, installed by this app only) replaces the shortcut,
  focus and timing guesses if the spike shows they matter.

**Amendment 2026-09-26 (review):**
- The chat is recognized by its exact title, "TabMail Chat". On macOS Thunderbird titles an add-on's
  popup window with the page title alone (`extension-popup-title` in `popup.ftl`, every locale), so no
  other title is the chat. A substring match also took a draft replying to a message about the chat
  ("Write: Re: TabMail Chat feedback"), or the main window showing a message whose subject starts with
  it, which would have got the message pasted in and Return pressed. A message whose subject is
  exactly "TabMail Chat" still passes for the chat: matching by title can't tell them apart.
- The relay's Accessibility calls into Thunderbird (window, focus, title, bring to front) run off the
  main thread, where the hotkey's event tap runs, and every element asked gets the
  `thunderbirdAccessibilityTimeout`, the focused window included (a timeout set on the application
  element does not carry over to the elements read from it). A hung Thunderbird then holds up only
  the relay, not the keyboard. Since those reads now suspend, the check that Thunderbird is in front
  comes after the title read (the user may switch away during it, and Accessibility still reports
  the chat as Thunderbird's focused window), and a cancel is honored before the paste and before
  Return. When that first read finds no chat, Thunderbird is checked to be in front again, and a
  cancel honored, before the shortcut: a false read can mean the user switched away, and ⌥⌘L
  would go to the app they switched to (Finder, Safari and Chrome bind it to Downloads).
- The chat is ready for a message only once its input has focus (Accessibility role `AXTextArea` in
  the "TabMail Chat" window), not as soon as the window has its title. A chat just opened has its title
  at once but focuses its input only after loading its history and building its context
  (`awaitUserInput`); pasting on the title plus a fixed 0.3 s settle lost the message on a cold open
  (owner, 2026-09-26: "it opens and then the message doesn't get through"). The relay waits up to
  `thunderbirdChatTimeout` (15 s, was 5) for the input, and the settle is gone. Measured on the owner's
  Thunderbird: a ready chat's focused element is the input, an `AXTextArea`.
- The relay is given the email app (a bundle identifier) with each send and asks every question
  (running, in front, focused window's title) of that app; it never reads Settings. The dictation
  takes the app from its key-down settings snapshot (ADR-DESK-017). Resolving the app from Settings
  at each check let a Settings change mid-send pair one app's chat title with another app in front,
  or press Return in the other app after the paste went to the first, submitting whatever draft its
  chat held.

**Amendment 2026-09-26 (add-on probe):** owner: "make sure that the tool doesn't show up if
Thunderbird does not have [TabMail] installed … sort of a probe?" There is an email app only while a
Thunderbird profile has TabMail's add-on (`thunderbird@tabmail.ai`) installed and enabled, which
closes the "cannot tell whether the add-on is installed" weak point above. `EmailClient.hasTabMail`
reads the profiles `~/Library/Thunderbird/profiles.ini` lists and each one's `extensions.json`; an
entry the user disabled (`userDisabled`) or Thunderbird disabled (`appDisabled`) does not count.
`active` is not used: Thunderbird leaves it `true` on an add-on the user has disabled (measured on
the owner's profiles). It is read at key-down with the rest of the settings snapshot (ADR-DESK-017),
so installing or enabling the add-on applies to the next dictation. Settings › Agent mode says when
the add-on is missing.
- Any profile counts. Thunderbird and Thunderbird Beta share the folder, and nothing in it says which
  profile a given installation opens, so the add-on in one profile turns the tool on even when the
  chosen Thunderbird opens another; the chat then never opens, as before.

## ADR-DESK-015: Debug builds log user content in full, to the local log file only

**Context:** Owner, 2026-09-26: an agent-mode reply came out of context, and nothing could say why.
The app logged lengths only, so what it had sent and received could not be read back. "We need more local observability. The raw responses and things that we send to the
backend … these logs are saved locally so we just want to be super detailed."

**Decision:** `Log.content(label, text)` writes a named block, whole, to the debug log file
(`~/Library/Logs/TabMail Voice/TabMail Voice.log`) and nowhere else: not the unified log, and
compiled out of Release builds. It carries:
- every backend request as sent (method, URL, headers, exact body), the prompt's variables one by
  one with their line breaks, and the raw reply (status, headers including `cf-ray`, whole body),
  also for an HTTP error (`BackendLog`, `CompletionsClient`, `TranscriptionClient`);
- the screen read at key-down: every field, the text around the caret, the visible text as the
  prompts get it (`ScreenContext.logDescription`);
- the transcript, the cleaned text, each agent tool's text, the text pasted and the chat message sent
  to Thunderbird.

Never logged: audio (the transcription request shows its size in its place) and the access token
(`Authorization` is masked). `Log.debug` and `Log.error` stay content-free.

**Consequences:**
- The debug log file on a developer's Mac holds screen text, mail and chat text. ADR-004 governs what
  the server keeps; this is a local file written only by builds from source.
- The file is capped at `logFileMaxBytes` (50 MB, was 5 MB), one earlier file kept: a dictation logs
  its screen read several times.
- A test sees the entries through the task-local `Log.contentObserver` (`ContentLogTests`, and the
  controller's paths in `DictationControllerTests`), which pins that the token and the audio stay
  out; the task-local `LogFile.destination` lets a test read an entry back from a file of its own.
- Builds from source are debug builds, so they keep this log too (README).
- *Amended 2026-09-30 (owner): a packaged (release) build writes the same log, content included,
  while debug mode is on, so a problem in the release build can be read back. Debug mode is offered
  only to the accounts `DebugAccess` allows, so no other user's build writes it. The log follows the
  switch and the account signed in as they change (`setDebugMode` in `core/log.ts`). The helpers now
  always send their `debug` lines and the app keeps them only while it logs. Keeping the last
  recording (audio) stays debug builds only.*

## ADR-DESK-016: Lay the screen read out as the screen shows it

**Context:** Owner, 2026-09-26: a Compose reply in a Slack DM swapped who said what; it thanked the
other person for help the user was giving. The read (ADR-DESK-007) had the whole conversation but
no authors: Slack's authors are buttons, and the walk skipped every button. Each piece of text was
also its own line, so an author, the time and the message were three unrelated lines. The owner's
direction: rather than patch one app, reconstruct how the screen looks and pass that on.

**Decision:** The walk keeps each piece of text's frame, and the visible text is laid out from the
frames: text and links side by side on one line are joined (`Alex [Today at 9:20:09 AM]`), anything
else starts a line, and a jump back up the window (the next pane) leaves a blank line. In web
content, controls and toolbars are read: a control adds its title when it has no description
(Chromium and WebKit title a control with the text drawn in it; a screen-reader label comes as the
description, and one Electron app reported it as the title too), else its children's text. Native apps title their
icon buttons ("Back", "Copy"), so outside web content controls and toolbars stay skipped. Text in a
box at most a point thin is left out: web apps keep screen-reader-only labels, list items scrolled
out of view (clipped to 1 point at the list's edge) and hover-only actions in such boxes. The box
is still walked into, since Slack keeps its whole message list inside a 1×2 screen-reader-only list.

**Consequences:**
- Measured 2026-09-26 with the reader compiled into a command-line tool against the running apps:
  Slack reads every message with its author and time and the thread as its own block; a chat panel in Chrome,
  an Electron chat app and Safari drop icon labels and scrolled-out history; Messages and Reminders
  read as before.
- Conversation scrolled out of view is no longer read (a chat side panel in Chrome: 5.9k → 1.3k chars).
  It was hidden, and read only because the web app kept it in the tree; the read is what is on
  screen.
- Messages grouped under one author header (Slack's follow-ups) carry no author of their own, as on
  screen; the model reads them as the author's above.
- Screen-reader-only text inside a normal-sized box under a 1-point one still comes through (Slack's
  "Canvas List Folder"); pruning 1-point boxes would drop Slack's message list.
- The walk reads elements through `ScreenTree` (`LiveScreenTree` in the app), so tests run it on a
  fake tree shaped like Slack's (`ScreenContextTests`), and once on a real window of the test host
  (`LiveScreenTreeTests`, which needs the Accessibility permission), beside the layout on frames measured in
  Slack and the hidden-box rule on frames measured in Slack and Chrome. Test text is placeholders,
  never what was on the measured screen.

## ADR-DESK-017: Settings are read once, as a dictation starts

**Context:** Owner standing rule, 2026-09-26 (root `Companion/Rules/Active/snapshot-settings-at-operation-start.md`):
"lock in all the settings … by taking a snapshot when everything starts … the snapshot is the first
thing that happens on the settings." Three review rounds in a row on the Thunderbird relay each
found another window where changing the email app in Settings mid-send paired one app's chat with
another; each fix compared Settings again and missed the next window.

**Decision:**
- `DictationController.start()` reads `AppSettings.dictation` (a `DictationSettings` value: consent,
  backend URL, screen reading, email app) as its first step at key-down, and the hold reads only that
  snapshot until it finishes: consent, whether the screen is read, the server every request of the
  hold goes to, the email app the Space toggle offers and the relay sends to. A change made during a
  hold applies from the next one.
- Nothing downstream reads Settings: the transcription and completions clients are made with the
  snapshot's URL, `ScreenContextProbe` no longer checks screen reading (the controller doesn't ask
  it), and `ThunderbirdRelay.send(_:to:)` is given the app.
- Facts about the world stay live: which app is in front (the key-down app for Edit and Compose), and
  whether the email app runs, is in front and has the chat focused.

**Consequences:**
- Every "does Settings still say X" comparison in the relay is deleted; a mid-send Settings change
  can no longer retarget a send.
- Not covered: the hotkey itself. Changing it in Settings reinstalls the monitor, which cancels a
  hold in progress (`HotkeyMonitor.setHotkey`); the owner accepts that behavior (2026-09-26).

## ADR-DESK-018: Debug mode, only for allowed accounts

**Context:** Owner, 2026-09-26: the menu's Start Dictation and debug items (Play Last Recording,
Show Last Screen Context, Show Log File) should show only in debug mode; debug mode is the
"Use development server" switch, and that switch should show only to the allowed debug accounts.

**Decision:**
- `DebugAccess` allows the same accounts as iOS `DebugModeManager`: the `tabmail.ai` domain and its
  short list of named addresses, compared case-insensitively.
- The Settings switch is now "Debug mode" (stored as `debugMode`), shown only while an allowed
  account is signed in. Debug mode is on only when the switch is on AND the account signed in is
  allowed (`AppSettings.isDebugMode(for:)`); a switch left on does nothing once another account, or
  none, is signed in.
- Debug mode sends dictation to the development server, and is part of the settings snapshot read
  at key-down (ADR-DESK-017, `dictation(for:)`).
- The menu shows Start Dictation and the debug items only in debug mode. A Stop for a recording in
  progress stays whatever the mode, so a recording can always be stopped (ADR-DESK-010). The debug
  items are also compiled only into debug builds, as before.

**Consequences:**
- Everyone else dictates with the hotkey only; the menu keeps setup, Welcome Guide, Settings and Quit.
- The old `useDevelopmentServer` switch isn't carried over: debug mode starts off once.

## ADR-DESK-019: Dictate in the keyboard's language, shown beside the waveform

**Context:** Owner, 2026-09-26 (issue #3): dictation must work in languages the backend's default
model does not cover (Korean first). The keyboard's language shows as a small circle left of the
waveform, as other dictation tools do; the request sends the language, and the backend picks the
model for it from a JSON file of language–model pairs (backend ADR-024).

**Decision:**
- At key-down, beside the app in front, `DictationController.start()` reads the active keyboard input
  source's language once (`KeyboardLanguage.current()`, Text Input Sources) into `language`. The
  recording is sent with it (`TranscriptionClient.transcribe(wav:language:accessToken:)`) and the
  overlay's badge shows it, so the two can never disagree. A keyboard switched during the hold or the
  upload applies from the next hold.
- The language is the source's first one, reduced to its ISO-639-1 primary subtag (`zh-Hans` → `zh`,
  `pt_BR` → `pt`); without a two-letter code (`yue`, `fil`, or no languages) none is sent and no badge
  shows. Every source's first language counts: macOS lists a Korean 2-Set's languages as `["ko"]` but
  the U.S. layout's as 96 languages with English first, so "several languages → none", as the issue
  first proposed, would have left every English keyboard without a language.
- It is sent for every language, including those the default model covers; the backend decides what
  it means (today: a model for the languages the default lacks, the model's own detection
  otherwise).
- The badge: the code in capitals (`KO`) in a small gradient-ringed circle, as tall as the waveform
  (the pill keeps its height), concentric with the pill's rounded left end, while the pill listens
  (not in the thinking circle or a message).

**Consequences:**
- The keyboard is a proxy: Korean said with the U.S. layout on goes to the default model, which does
  not cover Korean. There is no manual override in Settings yet; add one if that proves common.
- Needs the backend with ADR-024 deployed first: the earlier backend forwarded the language to its
  default model, asking it for languages it does not cover.

## ADR-DESK-020: Agent tools one file each, connectors one folder each

**Context:** Owner, 2026-09-26: agent mode will gain more tools and more connectors (apps a request
is handed to), so the code is split first. All three tools lived in one `AgentTool` enum inside
`DesktopAgent.swift`, their prompt, variables, fitting and delivery spread over that enum's switches,
`DesktopAgent.toolMessage`/`write` and a `switch tool` in `DictationController`; adding a tool meant
editing all of them. The owner chose one file per tool with an enum as the registry, structured like
the Thunderbird add-on (`chat/tools/<tool>.js`, routed by `chat/tools/core.js`) and the iOS app
(`Services/AI/Tools/<Name>Tool.swift` behind the `AgentTool` protocol), over a folder-only move or a
protocol-and-registry design with generic connectors.

**Decision:**
- `Agent/AgentTool.swift` holds the registry: the `AgentTool` enum (raw value = the name the agent
  answers with; `Hashable`, so the phase and the bubbles keep using it) maps each case to its
  implementation, a `AgentTool`. The protocol gives a tool its display name, symbol, backend prompt,
  prompt variables (default: `screenVariables`, the request and the key-down screen read), the fitting
  of the written text (default: as written) and `deliver(_:in:)`. `ToolContext` is what a tool
  delivers with: the dictation's settings snapshot (ADR-DESK-017), the inserter, whether the key-down
  app is still in front, and the connectors.
- `Agent/Tools/` has one file per tool: `EditTool` (fits to the selection, pastes over it),
  `ComposeTool` (adds `terminal_program`, pastes at the caret), `ThunderbirdTool` (hands the message
  to the Thunderbird connector for the snapshot's email app). Edit and Compose paste through
  `ToolContext.pasteIntoTargetApp`, which keeps the `appChanged` check.
- `Agent/Connectors/<App>/` has one folder per connector: `Connectors/Thunderbird/` holds
  `EmailClient` and `ThunderbirdRelay`, unchanged.
- `DesktopAgent` keeps what is about the agent, not a tool: which tools are offered, the choice, the
  write call and its `Failure`s. `DictationController` calls `tool.implementation.deliver` instead
  of switching on the tool.

**Consequences:**
- A new tool is a case in `AgentTool`, a file in `Tools/`, and its prompt name in `DictationConfig`.
  When it is offered stays in `DesktopAgent.tools(for:emailAppAvailable:)`/`tool(for:…)`, since the
  offer rules (the selection picks Edit or Compose; the email app gates Thunderbird) span tools.
- A new connector is a folder in `Connectors/`, passed into `DictationController` and carried in
  `ToolContext`. There is no `Connector` protocol yet: with one connector there is nothing to
  generalize, and the next one decides its shape.
- The bubble's app icon still comes from `tool == .thunderbird` in `OverlayPanel` (left alone while
  another branch changes that file); a second app-backed tool moves it into the protocol.
- No behavior change: the suite passes unchanged except `fitted(_:toSelection:)` moving from
  `DesktopAgent` to `EditTool`.

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
  amendment of 2026-09-27), then transcribed.
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

## ADR-DESK-022: The Answer tool, the chat window, and agent tools switched on and off

> ⚠️ **Amended by ADR-DESK-036 (owner 2026-09-28):** the chat window no longer replaces the pill or
> opens at the caret's line (`chatFrame`, `chatOpensUpward`): it opens over the pill, which stays
> where it was with its bubbles (under them only without room over them), and rests there as a small
> circle between follow-ups. The status pill inside the window is gone.

**Context:** Owner, 2026-09-26: agent mode gains an Answer tool whose reply is shown, not pasted, in a
chat window that grows from the pill. With the window open, the hotkey starts a follow-up, "always in
agent mode". Escape or the window's X closes it; untouched it closes after 30 seconds, "like iOS
undo", with a bar showing the time left; a hover, click or scroll ends that timeout for good ("the
30-second thing is when there's no behavior"), and a click elsewhere does not close it. The owner also
asked that the availability of each tool be sent to the backend, "because the tool JSON definitions
live in the backend", and that every tool be in the welcome wizard and Settings, "toggleable, on by
default". First built in the Swift app; built here in the Electron app (ADR-DESK-032), which is the
one that ships.

**Decision:**
- `src/core/agent/tools.ts`: `AnswerTool` (`answer`); its prompt `system_prompt_desktop_answer`
  (backend ADR-023 amendment) replies with text that `deliver` hands to `ToolContext.showAnswer`.
  Each tool carries a `settingsDescription` and a `chatCaption` (what it did with its text; none for
  Answer).
- The tools offered (`DesktopAgent.tools(context, enabled, emailAppAvailable)`): the selection's
  writing tool (Edit or Compose), Thunderbird while an email app is available, and Answer, each only
  while enabled. None → `AgentError("noToolEnabled")`, with no completions call; one → it runs,
  with no choice call; more → the choice request lists them in `available_tools`
  (`CompletionsClient.complete`), and a reply naming a tool not offered is `noTool`. The agent's pick
  of the other writing tool is no longer overruled: that tool is not offered.
- `AppSettings` keeps the tools switched OFF (`disabledAgentTools`), so every tool, and every tool
  added later, is on until the user turns it off. `DictationSettings.enabledTools` is part of the
  key-down snapshot (ADR-DESK-017). Settings' Agent mode section and the wizard's Features step show
  one switch per tool, with its icon and `settingsDescription` (`setAgentToolEnabled`).
- `src/core/agent/chat.ts`: `AgentChat` (in memory only, gone when the window closes; root
  ADR-004) holds the turns: the request, the tool and its reply (an answer, or the text another tool
  pasted or sent). A follow-up sends `chatTranscript` to every prompt as `conversation`
  (`User: …` / `TabMail[ [caption]]: …`), so "why?" or "shorter" refers to the last reply. A
  follow-up another tool carries out is added to the chat with its caption. `formattedReply` renders
  inline Markdown only; a link that is not a web page's (`opensLink`) shows as plain text, as a reply
  carries the words on screen.
- `DictationController.chat` is the window's state (`onChatChange` on open and close). An answer
  opens it (`closesAt` = now + `chatTimeout`); `keepChatOpen()` (a hover, click or scroll in the
  window, or a follow-up) clears the timeout, and does nothing once it has closed; `closeChat()`
  (Escape, X, or the timeout) drops the conversation and discards a follow-up under way, or the
  failure a follow-up left showing. With the chat open, `start()` is a follow-up:
  agent mode from the start, Space switches nothing, no tips.
- `PushToTalkGesture.isChatOpen` in the `voice-hotkey` helper (the `setChatOpen` request, sent on
  every open and close and again when the helper restarts): Escape is kept from the app and closes
  the window (the `closeChat` action), during a follow-up too, held or hands-free, which closing it
  cancels; a held follow-up's key-up then does nothing. The helper handles each request in its own
  task, so two sent together can be applied in either order (found in review: an open and a close
  together left Escape kept after the window closed); the main process sends the hotkey's state
  (`configure`, `setChatOpen`) one request at a time, each after the last is answered, so the helper
  ends in the state sent last. A failed request holds up none after it.
- The conversation belongs to the account it was held under: `AccountModel.onAccountChange`
  (sign-out, or another account signing in, not a refreshed token) ends it and any agent request
  under way before the next account can send anything. A dictation under way goes on and is pasted
  as heard, without the cleanup (ADR-DESK-008).
- Nothing that finishes late writes to a newer chat: every step of a request checks its generation
  after each await, the answer and the delivery too, and the chat window drops a caret lookup still
  under way when it opens, so it stays where it opened.
- `OverlayWindowController.update(phase, chatOpen)`: the overlay window shows the chat window
  instead of the pill while the chat is open, takes the mouse only then (`setIgnoreMouseEvents`), and
  fits the height the page measures (`chatHeight`, at most `chatMaxHeight`, then it scrolls to the
  newest turn when a turn, the request under way or the follow-up's status changes, and not for a
  push that shows nothing new, so an earlier answer the user scrolled up to stays put), so only
  the shadow's margin around it catches clicks. It opens where the pill was (`chatFrame`), below the caret's line,
  or above it when the tallest window would not fit below (`chatOpensUpward`), and stays there for
  follow-ups. The window accepts the first click (`acceptFirstMouse`) without taking focus. The page
  sends `keepChatOpen` on pointer enter, move, down and wheel. A link opens through the main process
  (`openChatLink`), which checks it again and opens it only while the chat is open.

**Consequences:**
- The backend's ADR-023 amendment deploys before this build: an older backend ignores
  `available_tools` and has no answer prompt.
- Closing the chat while a follow-up is running cancels it before its next step: nothing more
  reaches the app, but a Thunderbird request closed between its paste and its Return is left typed,
  unsent, in TabMail's chat (the relay's cancellation, as before).
- The conversation is sent in full with every follow-up (no truncation); a very long one ends in a
  backend context-length error for that follow-up.
- Whether hover and the first click reach the never-focused overlay window on macOS is checked by
  hand; the tests drive the page's events and the window's calls.

## ADR-DESK-023: The Answer tool's loop, with tools that run on this computer

**Context:** Owner, 2026-09-26: agent mode gains tools that run on the user's computer (calendar,
reminders, contacts, file search, email prefill, notes, messages, shortcuts, web), "the tool JSON
definitions live in the backend", and "sending or creating anything, you should ask for confirmation
first". The backend gave the app its own `macos` platform, whose Answer prompt runs the
function-calling loop with the tools the app lists in `available_tools` (backend ADR-017
amendment), starting with its own date tools. ADR-DESK-011's "no client-side tools" held while the
app read Thunderbird's registry; it no longer does. First built in the Swift app; built here in the
Electron app (ADR-DESK-032), which is the one that ships.

**Decision:**
- The Answer prompt is a loop (`DesktopAgent.answer`); Edit, Compose and Thunderbird stay one call
  each, and the choice stays one call. Each round (`CompletionsClient.round`) sends tools on
  (`disable_tools: false`), `available_tools` = the backend's date tools
  (`config.answerServerTools`) plus every `ConnectorTool`'s name (`DesktopAgent.answerTools`), and, after
  the first round, the loop's `conversation_state`. A round either replies (the answer) or returns
  `tool_calls` (each an `id`, a function `name` and its `arguments` as a JSON string; anything else
  is `invalidResponse`) and the state.
- The state stays opaque JSON: the app appends one `role: tool` message per call to its
  `harmony_messages` (`content`, `tool_call_id`), sets `current_round` to the rounds it has run, and
  sends every other field back as it came (reasoning signatures included). The backend's round limit
  counts that `current_round`, as for the iOS app (`BackendClient.sendCompletionsWithToolsInternal`).
  State without a `harmony_messages` array is `invalidResponse`, and no tool runs. The request's
  `AbortSignal` is checked before each round and each call: a request canceled while a tool ran
  runs no later call and sends no further round.
- `ConnectorTool` (`src/core/agent/connectors/contract.ts`): a tool that runs on this computer: its backend function
  `name`, a `progressLabel`, a `confirmation(args)` question for one that sends or creates (null for
  a read), and `run(args)`. The controller takes them as `DictationDependencies.connectorTools`, which the
  main process builds (a tool reaches the OS through a native helper); the list is empty until the
  first connector (a later PR). The backend's server tools (the date tools) run on the backend.
- `DictationController.runLoopTool`: a call to a tool the app doesn't have, or with arguments that
  aren't a JSON object, runs nothing and tells the model why (`Error: …`), as does a tool that
  throws (its error's message). The chat window opens for the first tool (if the request was not a
  follow-up), showing the request and the tool's `progressLabel` (`AgentChat.activity`) while it
  runs. A tool with a `confirmation` asks it in the window (`AgentChat.confirmation`, Cancel /
  Confirm, the `answerConfirmation` command) and runs only once confirmed; declined, the model
  reads `config.loopToolDeclined`. An answer that comes before the question has shown for
  `config.chatConfirmationMinimumDisplay` (half a second) is ignored: the second click of a
  double-click on one question's Confirm, or a click aimed at its card as the next question
  replaces it, would otherwise confirm a question the user never saw (found in review; a question
  id sent back with the answer would catch only the stale card). Closing the window or canceling
  the request declines the question at once (`teardown`, the one place a request ends) and drops
  the request: the round's request in flight is canceled, the round's later calls don't run, and
  nothing is left waiting for the answer. A tool still running for a request that ended clears
  nothing of a newer one's.
- The chat window's timeout starts when the first answer joins it, and only if the user has not
  touched it (`AgentChat.touched`, which the page reads too, so a touch counts before the timeout
  starts): a window a tool opened waits for the answer, and one touched while a tool ran stays
  open. Each window opens untouched, so one touched and closed leaves the next to
  time out. A request that fails, is canceled or ends with the account after a tool opened an empty
  window closes it (`teardown`): the pill says what failed, and the next hold dictates.
- The date tools are not a switch in Settings or the wizard: they read nothing of the user's and
  only make dates right. Each tool that runs on this computer adds its switch with its connector.

**Consequences:**
- The backend's `macos` platform (ADR-017 amendment) is deployed before this build: an older backend
  offers the Answer prompt no tools, and the answer is written without them.
- Server tools run inside a round and show no progress in the chat window (the whole stream is read,
  then parsed); a slow server tool (web search, later) would need the stream read as it arrives.
  *(Later (ADR-DESK-036): the stream is read as it arrives, and a server tool's start and end show.)*
- A request waiting on a confirmation holds agent mode: the hotkey starts nothing until the user
  confirms, declines or closes the window, or the question's time runs out (below).
- Each round has the completions request timeout of its own (`completionsRequestTimeout`); a tool's
  run has none. A confirmation had none at first.

**Amendment 2026-09-28: a question has 30 seconds.** Owner: "Confirmation should get a time limit of
30 seconds max, and it should show a timer ticking, similar to the undo toast that we have." (It came
up as an event confirmed after its time had passed.)
- A question left unanswered for `config.chatConfirmationTimeout` (30 seconds) is declined: the tool
  doesn't run, and the model reads `config.loopToolUnanswered` ("didn't confirm in time"), not the
  decline, so it can say why. A touch in the window doesn't stop the clock, as it does the window's
  own timeout: the limit is a maximum.
- `AgentChat.confirmationExpiresAt` says when; the card shows the time left as a thin bar along its
  bottom edge, the chat window's `TimeoutBar` (itself the iOS undo toast's), timed by the question's
  own timeout.
- Each question has its own clock, stopped by any answer (the user's, the window closing, the request
  ending), so one answered in time never declines the next.

## ADR-DESK-024: Calendar and Reminders, the first apps the Answer tool reaches

**Context:** Owner, 2026-09-26: the Answer prompt's tools reach the user's apps, each a switch in
Settings and the welcome wizard, "toggleable on by default"; "sending or creating anything, you
should ask for confirmation first"; a macOS permission refused fails with a message saying where to
grant it. The backend defines the four tools (`calendar_read`, `calendar_event_create`,
`reminders_read`, `reminder_create`, `src/tools/macos/`), their dates ISO 8601 without an offset, in
the user's zone. First built in the Swift app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- A connector is an app the tools reach (a `Connector`, declared in its own file in
  `src/core/agent/connectors/` with its display name and description, ADR-DESK-044), and each `ConnectorTool` names its `connector`. Settings stores the switched-off
  names (`disabledConnectors`, so a new connector starts on and a retired name is ignored); the
  enabled ones are in the key-down snapshot (`DictationSettings.enabledConnectors`, ADR-DESK-017),
  and a request lists in `available_tools`, and runs, only the tools of the connectors on then. The
  switches follow the agent tools' in Settings' Agent mode and the wizard's Features step
  (`setConnectorEnabled`).
- The tools are `src/core/agent/connectors/calendar.ts` over an `EventStore` the main process gives them;
  on macOS that is `voice-macos` (`EventStore.swift`, EventKit), elsewhere there is none and no
  connector is offered or shown. Reads need nothing confirmed; adding an event or a reminder asks,
  and the question is built from the same draft the tool then adds, so what is confirmed is what is
  added. A day as an event's start is an all-day event; with no end, an event lasts
  `config.calendarEventDefaultDuration` (an hour); a day as an end means through that day, and an
  all-day event over several days reads as its first to its last day. Bad or missing arguments
  throw `ToolArgumentError`, which the model reads (ADR-DESK-023).
- The backend's dates are parsed in the local zone in core (`LocalDateTime`), and cross the wire as
  milliseconds since 1970, so the helper does no date parsing; a reminder due on a day carries
  `dueHasTime: false` and is stored with no time. A reminder's due date is stored as Gregorian
  components in the Mac's zone (`ReminderItem.dueCalendar`), as EventKit reads them whatever
  calendar the Mac is set to: in the Mac's own calendar a Buddhist-calendar Mac stored a date 543
  years late. The helper sets an event's `isAllDay` before its dates (`EventKitStore.fill`): set
  after, EventKit moves an all-day event's end back to its first day, losing the rest.
- `calendar_read` refuses a range longer than `config.calendarReadMaxDays` (four years of 365
  days): EventKit reads at most four years of events for one request and silently drops the rest,
  so a longer read would report events missing. The model is told to read it in parts.
- `EventKitStore` takes its `EKEventStore` and authorization status (EventKit's own by default),
  and `MacService.register` its `EventKitStore`, so the helper's tests read and save through a
  stand-in `EKEventStore` subclass, never the user's calendars.
- The helper asks for full access on first use (`requestFullAccessToEvents`/`…ToReminders`); the
  packaged app carries the usage strings (`NSCalendarsFullAccessUsageDescription`,
  `NSRemindersFullAccessUsageDescription`) and the `personal-information.calendars` entitlement,
  since the prompt is attributed to the app. A refusal (a request for access that fails counts as
  one), or no default calendar or list, goes back by
  name (`calendarNoAccess`, `remindersNoAccess`, `noDefaultCalendar`, `noDefaultList`) and becomes an
  `EventStoreError` whose message names where to grant access (System Settings › Privacy &
  Security › Calendars or Reminders); the model reads it and tells the user.
- A call waits `config.eventStoreRequestTimeout` (two minutes), long enough for the user to answer
  the permission prompt.

**Consequences:**
- A new connector is one file declaring it (`defineConnector`), taking its OS access as an interface,
  and the helper methods behind it; the switch, the snapshot and the offer come with the name.
- The permission prompt raised from a helper process, attributed to the app, is checked by hand on a
  signed build (TESTS.md).

## ADR-DESK-025: Contacts, the third app the Answer tool reaches

**Context:** Owner, 2026-09-26: the Answer tool looks people up in the user's contacts and adds
them (the backend's `contacts_search` and `contacts_add` in its `macos` registry), under the same
rules as Calendar and Reminders (ADR-DESK-024): one switch, on by default, in Settings and the
wizard; adding asks first; access is asked on first use and a refusal says where to allow it. First
built in the Swift app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `contacts` connector, with `src/core/agent/connectors/contacts.ts`: `ContactsSearchTool` and
  `ContactsAddTool` over a `ContactStore` interface. On macOS the store is `voice-macos`
  (`ContactStore.swift`, the Contacts framework); elsewhere there is none.
- A search matches a contact's name (either way round), company or an email address, ignoring case
  and accents (`ContactMatch`), in the user's sort order. The helper matches, reading every contact
  it enumerates (the framework's name predicate matches neither email addresses nor accents) and
  stopping at the limit, so the address book never crosses the wire. The model sees at most
  `config.contactsSearchMaxResults`; the tool asks for one more to say that more match. Phone numbers
  are returned, not searched.
- `contacts_add` needs a name, a company or an email address; one email address and one phone
  number, as the backend's schema gives them. The question and the contact come from one `draft`,
  and every field added is shown (ADR-DESK-024). It goes to the default container.
- Access is asked on first use (`CNContactStore.requestAccess`); without it (a request that fails
  counts as a refusal) the helper refuses with `contactsNoAccess`, which becomes a
  `ContactStoreError` naming System Settings › Privacy & Security › Contacts. A call waits `config.contactStoreRequestTimeout`, as long as Calendar's, for
  the prompt. The framework's calls block, so the helper runs them off its main thread.
- The packaged app carries `NSContactsUsageDescription`; the hardened runtime gets
  `com.apple.security.personal-information.addressbook`.

**Consequences:**
- Matches go to the model only: nothing is stored (ADR-004).
- A search reads the whole address book in the helper when fewer than the limit match; fine for a
  personal one, and the model's results stay capped.
- The permission prompt raised from the helper is checked by hand on a signed build (TESTS.md).

## ADR-DESK-026: Files, Spotlight search the Answer tool can open from

**Context:** Owner, 2026-09-26: the Answer tool finds files ("the PDF from last week") and, where the
user has Apple Mail, its messages, through Spotlight, and opens a hit; one switch, on by default, in
Settings and the wizard (ADR-DESK-024). Opening is neither sending nor creating, so it asks nothing.
The backend defines `files_search` and `file_open` (`src/tools/macos/`). First built in the Swift
app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `files` connector with `FilesSearchTool` (`files_search`) and `FileOpenTool` (`file_open`)
  (`src/core/agent/connectors/files.ts`) over a `FileStore`: on macOS `MacSystem.fileStore`, whose
  `filesSearch` and `fileOpen` requests `voice-macos` carries out (`FileSearch.swift`). A failure
  comes back by name (`Files.Failure`, `FileStoreError`), so a file's name in the system's error
  never reaches a log.
- `SpotlightQuery` (in the helper) builds the query: every word in the display name, the text
  content (word prefix), or an email's subject, senders or sender addresses, ignoring case and
  accents; a kind from the backend's list as content types (`document` = composite content or
  text); `changed_after`/`changed_before` on the content change date, a day as the end reading
  through that day (the app reads the dates, `Arguments.localDate`/`localEnd`, and sends them in
  milliseconds). Words are escaped, so a quote cannot end a value and `*` matches itself. `MDQuery`
  runs synchronously off the main thread, in the home folder, gathers at most
  `HelperConfig.filesSearchScanLimit`, and keeps the newest (`Files.newest`); the app asks for
  `filesSearchMaxResults` + 1 to say that more match. Paths go to the model with the home folder as
  `~`, which `file_open` expands (`~user` and relative paths are refused).
- Apple Mail messages are found when Spotlight has indexed them (`.emlx`, shown by subject and
  sender) and opened like any file, by path: Launch Services opens them in Mail.
- `OpenPolicy` (in the helper): `file_open` opens only a plain folder or a type conforming to PDF,
  image, audiovisual content, presentation, spreadsheet, composite content, text or email, and not
  to source code (scripts are source code), to executable (macro-enabled Office documents, `.xlsm`,
  `.docm`, `.pptm` and the like, are composite content and executable) nor to the XML types that launch a Java app or install a
  configuration profile (`.jnlp`, `.mobileconfig`, `.configprofile`, `.provisionprofile`), which
  the Swift app opened. Anything else (apps, `.command`, installers, Terminal settings,
  `.webloc`/`.fileloc` links, disk images, archives, shortcuts, no extension) is none of the opened
  types and is shown in the Finder instead, and the model is told why; `reveal` shows even a
  document. The type comes from the name's extension, as Launch Services picks the opening app by
  it; a symbolic link or a Finder alias, which opens what it points to whatever its own name says
  (`Invoice.pdf` pointing at a script), is only shown. A path planted in screen text or a file can
  therefore at most open a document.
- A package (a folder the Finder shows as one item) is typed as a package (`.rtfd` names only a
  package type) and opens only when it is rich text with attachments or a Pages, Keynote or Numbers
  document (`OpenPolicy.openedPackages`). Most other packages are composite content too, among them
  Xcode projects, workspaces, toolchains and playgrounds, Swift packages and app preference bundles,
  several of which run or install something as they open, so every other package is only shown
  (review 2026-09-28: the extension-only lookup showed a real `.rtfd` and told the model it could run
  something; a census of this Mac's registered package types found those among the composite ones).
- An item that isn't there fails (`openFailed`), shown or not: the Finder shows nothing for a missing
  item and reports nothing, so the model would otherwise say it showed it.
- The Swift app's shown-only list also named application and property list; no type among the
  opened ones conforms to application, and the property lists that are text (`.entitlements`,
  `.aupreset` and the like) are harmless XML, so both are left out.

**Consequences:**
- No new permission: Spotlight queries and Launch Services need none. Which items in folders macOS
  protects Spotlight returns to the helper is macOS's call; the app asks for no Full Disk Access.
- Found names, paths and email subjects go to the model only: nothing is stored (ADR-004).
- A search as broad as one letter sees only the first `filesSearchScanLimit` items Spotlight
  gathers, not necessarily the newest.
- An HTML page, an `.ics` or a `.vcf` is a document here: it opens in the browser, Calendar or
  Contacts, which ask before importing anything.
- Offered on macOS only, with the other connectors.

## ADR-DESK-027: Email, a prefilled new message in the user's email app

**Context:** Owner, 2026-09-26: without TabMail, mail is prefill only: Apple Mail, Thunderbird
without the add-on and any other email app get a filled-in compose window and the user presses
Send; the agent never sends mail. One switch, on by default, in Settings and the wizard
(ADR-DESK-024). The backend defines `email_compose` (`src/tools/macos/`): `to`/`cc`/`bcc` address
lists, `subject` and `body`, passed to the app as the model wrote them. First built in the Swift
app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `email` connector with `EmailComposeTool` (`src/core/agent/connectors/email.ts`) over an
  `EmailOpener` the main process gives it.
- One mechanism for every email app: a `mailto:` URL (RFC 6068, `mailtoURL`) opened with the app
  the system opens `mailto:` links with. Every value is percent-encoded from its UTF-8 bytes, leaving
  only the unreserved set (and `@` in an address), so an `&`, `=`, `?` or `#` the model writes stays
  in its field and cannot add a header; line breaks are CRLF; a lone surrogate becomes U+FFFD
  rather than failing the call.
- The main process asks `voice-macos` for the default email app (`emailApps`, which Settings
  already uses), names it in the result, and opens the URL with `shell.openExternal`. With none,
  the tool fails with `NoEmailAppError`, whose message the model passes on.
- Nothing is sent, so nothing is asked first. At least one recipient, a subject and a body are
  required, and every recipient must be one address (`isAddress`); a name goes back to the model
  to look up with `contacts_search`.
- Not used: Apple Mail's AppleScript (`make new outgoing message`) and Thunderbird's `-compose`.
  `mailto:` fills every app the same way with no Automation permission prompt; it gives up
  attachments and reply threading (a reply is a new message to the sender with "Re: ").
- Its icon is an open envelope with a letter, told apart from the Thunderbird tool's closed one.

**Consequences:**
- No new permission or entitlement.
- The draft goes to the email app only: nothing is stored (ADR-004).
- How long a body a `mailto:` URL carries is up to the email app; not measured.
- Offered on macOS only, with the other connectors, though the mechanism is Electron's and would
  work elsewhere once the default app can be named there.

## ADR-DESK-028: Notes and Messages, through AppleScript

**Context:** Owner, 2026-09-26: the agent answers from Apple Notes, adds notes, and sends iMessages;
AppleScript is acceptable where the app has no framework. Sending or creating anything is confirmed
first (ADR-DESK-023). One switch per app, on by default, in Settings and the wizard (ADR-DESK-024).
The backend defines `notes_search {query}`, `notes_create {title, body}` and `messages_send {to,
text}` (`src/tools/macos/`). First built in the Swift app; built here in the Electron app
(ADR-DESK-032).

**Decision:**
- The `notes` connector with `NotesSearchTool` (`notes_search`: notes whose title or text contains
  the query, locked notes left out, newest first, at most `notesSearchMaxResults` in full, more
  said) and `NotesCreateTool` (`notes_create`: a title and text, added to the default account's
  default folder once confirmed), in `src/core/agent/connectors/notes.ts`. The `messages` connector with
  `MessagesSendTool` (`messages_send`: one iMessage to one phone number or email address, once
  confirmed; a name goes back to the model to look up with `contacts_search`), in
  `messages.ts`.
- Neither app has a public framework, so each tool runs a fixed AppleScript through a
  `ScriptRunner` (`appleScript.ts`, faked in tests). What the model wrote reaches the script only
  as `argv`, never inside its source, so no text can change what a script does. The arguments
  follow `--`, so one that looks like an option (`-e …`) is data too (without it, a search for `-e`
  plus script ran that script unconfirmed).
- The runner is `/usr/bin/osascript` launched from the **main process** (`src/main/native/osascript.ts`),
  not a `voice-macos` method. The one reason is cancellation: `ConnectorTool.run` now takes the
  request's `AbortSignal`, and a canceled request or a closed chat window ends the osascript
  process. The helper channel can't call off a request it has taken, so a script run there would
  keep going, a send included, until it finished or timed out. This is a system program run with
  arguments, not native code in Node, so `apps/desktop`'s rule (OS work in a native helper, never
  a Node addon) is kept in spirit; the scripts are plain text either way. A request already
  canceled starts no process: Node starts one for an aborted signal and ends it only a tick later.
- Each script waits at most `appleScriptTimeoutSeconds` for the app to answer each command it
  sends (`with timeout`); a whole run has no deadline (ADR-DESK-023), and canceling ends it. A search's
  output is capped at `appleScriptMaxOutputBytes`; past it the search fails rather than cutting a
  note short.
- A note's text is written as Notes' HTML (`NotesScripts.html`): the title as its heading, one line
  per line, escaped, so what the user confirmed is what the note shows.
- Access: macOS asks the first time the app sends Notes or Messages an Apple Event
  (`NSAppleEventsUsageDescription`, the hardened runtime's `automation.apple-events` entitlement).
  A refusal (-1743) fails the request with where to allow it (System Settings › Privacy & Security
  › Automation), naming the app the script tells (`ScriptError.noAccess`).

**Consequences:**
- The first use of each app raises macOS's Automation prompt, and launches the app if it is not
  running.
- Notes' text and the message go to the model and the app only: nothing is stored (ADR-004).
- Messages sends over iMessage only; SMS through a paired iPhone is not offered. A send canceled
  after Messages has taken it may still go out.
- Unverified against a live Notes library: whether its `notes` include "Recently Deleted" ones, and
  how long a search over a large library takes (each command bounded by `appleScriptTimeoutSeconds`,
  the whole search only by a cancel). No test
  sends an Apple Event to either app: the scripts are compiled against each app's dictionary
  (`osacompile`), and the runner is tested on scripts that tell no app.
- Offered on macOS only, with the other connectors.

## ADR-DESK-029: Shortcuts, listed and run through the `shortcuts` command

**Retired 2026-09-28, before the first release** (owner: "Let's not support shortcuts for the first
release … I don't need shortcuts at all"). The connector, its tools (`shortcutsTools.ts`), the main
process's `shortcuts.ts`, their tests, config and icon were deleted; the last source is in git
history (PR #41). A stored `shortcuts` in `disabledConnectors` is a retired name and turns nothing
off (ADR-DESK-024). What follows is the decision as it was built.

**Context:** Owner, 2026-09-26: the agent can run the user's shortcuts; running one counts as doing
something, so it is confirmed first (ADR-DESK-023). One switch, on by default, in Settings and the
wizard (ADR-DESK-024). The backend defines `shortcuts_list {query?}` and `shortcuts_run {name}`
(`src/tools/macos/`). First built in the Swift app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `shortcuts` connector with `ShortcutsListTool` (`shortcuts_list`: every shortcut's name, or
  those whose name contains the query ignoring case and accents, at most `shortcutsListMaxResults`,
  more said) and `ShortcutsRunTool` (`shortcuts_run`: one shortcut by its exact name, once
  confirmed; its text output back to the model), in `src/core/agent/shortcutsTools.ts`.
- Both run `/usr/bin/shortcuts` (`ShortcutsRunner`, faked in tests) from the **main process**
  (`src/main/shortcuts.ts`), for ADR-DESK-028's reason: a canceled request or a closed chat window
  ends the command. Whether a shortcut already running in Shortcuts stops with it is unverified (on
  the by-hand list). The name is one argument, never parsed by a shell, after
  `--`, so a name that looks like an option is the name (without `--`, `shortcuts run …
  --help` prints the help and succeeds). The output is asked for as plain text
  (`--output-type public.plain-text`), capped at `shortcutsMaxOutputBytes`.
- A run takes the name the user confirmed and runs only if a shortcut has exactly that name; any
  other name is sent back to the model to look up with `shortcuts_list`.
- A run takes no input, and its stdin is closed at once: `shortcuts` reads an open stdin as the
  shortcut's input and waits for it, so with Node's default pipe every command hung (found by the
  test that runs the real command). Passing the model's text to a shortcut is left for the owner
  to ask for.

**Consequences:**
- No permission of TabMail Voice's own; a shortcut's actions ask for theirs as Shortcuts does.
- Shortcut names and output go to the model only: nothing is stored (ADR-004).
- A shortcut that waits for the user (a dialog, a menu) keeps the request running until it is
  answered or the request is canceled.
- No test runs a shortcut of the user's: the command is a stand-in script, and the real one is only
  asked to run a name like an option, which it looks up and does not find.
- Offered on macOS only, with the other connectors.

## ADR-DESK-030: The web, searched on the backend, read and opened on this computer

**Context:** Owner, 2026-09-26: the agent can search the web and read and open pages. One switch,
on by default, in Settings and the wizard (ADR-DESK-024). The backend defines `search_web` (which
runs on the server), `web_read {url}` and `web_open {url}`. First built in the Swift app; built here
in the Electron app (ADR-DESK-032).

**Decision:**
- The `web` connector with `WebReadTool` (`web_read`) and `WebOpenTool` (`web_open`), in
  `src/core/agent/connectors/web.ts`, and the backend's `search_web`. A connector's backend tools
  (`Connector.serverTools`) are listed in `available_tools` after the date tools while its own tools
  are (switched on at key-down, and on this computer), so a platform without the web's tools offers
  no search either; `web_search_enabled` is sent as whether `search_web` is listed (the backend refuses
  `web_read` and `web_open` too without it).
- `web_read` is a port of the add-on's `web_read` and the iOS app's `WebReadTool`
  (`WebPageReader`): the site's robots.txt is asked first (one that can't be read allows; a cancel
  ends the read), then the page, both as `webUserAgent`; an HTML page comes back as its text
  (extracted by the add-on's rules, without a DOM), other text as it is in the charset it names
  (UTF-8 for one the runtime doesn't know), cut at `webReadMaxCharacters`, in the same result
  format. The fetch (`liveWebFetch`, injectable as `WebFetch`) follows redirects, as the add-on's
  does, and reads at most `webReadMaxBytes` of a body, so an endless page never fills the memory.
- `web_open` opens the page in the default browser (`shell.openExternal`). Both take only a
  complete `http`/`https` URL with a host: another scheme could open an app (a `shortcuts:` link
  runs a shortcut).
- Neither asks first: reading and opening a page is neither sending nor creating (ADR-DESK-023).
  Which URLs the model may pass is the backend's guard, the one `web_read` has on every platform:
  only a URL the user said or one in an earlier tool result, never a private address, and never a
  URL that appears only on the screen (the screen read is text the model can't vouch for).

**Consequences:**
- A page on the user's screen can be read or opened only once the user says its address or a search
  finds it.
- Pages go to the model only: nothing is stored (ADR-004).
- The robots.txt group match is the add-on's: a group applies when its `User-agent` is `*` or the
  whole `webUserAgent` string, so a group naming TabMail by a short token is not read as ours.
- The main process decodes a charset with Electron's `TextDecoder`, which reads `windows-1252`
  0x80–0x9F as curly quotes and dashes; plain Node 24, which runs the tests, decodes them as control
  characters, so the tests use an ISO-8859-1 page.
- The text is extracted on the main process, so extraction takes time linear in the page: each
  chrome element is found with its closing tag in one pass, and a tag ends at the next `<` or `>`.
  A regex that rescans to the end from every unclosed `<` (a lazy `<script>…</script>`, or
  `<[^>]+>`) held the app for 35 seconds to 4 minutes on a hostile page of half a million `<` or
  `<script` (review, 2026-09-28). A chrome tag's name ends at a space, `/` or `>`, so a custom
  element such as `<nav-menu>` stays page text, and a closing tag may have spaces before its `>`.
- Offered on macOS only, with the other connectors.

## ADR-DESK-031: While fn is the hotkey, the Globe key's own action is off

**Context:** Owner, 2026-09-27: with fn as the hotkey, a press or a double tap also switched the
input source, macOS's "Press 🌐 key to" action. The event tap cannot stop it: WindowServer runs the
Globe action ahead of every event tap (reported by OpenWhispr, TTP and input0, all of which tried
to swallow the event), so returning nil from `HotkeyMonitor`'s tap changes nothing. Most dictation
apps that default to fn ask the user to pick "Do Nothing"; Settings asked the same. Offered that or
switching the setting for the user, the owner chose the second ("option 2").

**Decision:**
- While fn is the hotkey, `GlobeKeyAction` sets the Globe action to Do Nothing, and puts the user's
  choice back when another key becomes the hotkey or the app quits (`NSApplication.willTerminateNotification`,
  observed in `AppDelegate.connectHotkey`, which also points the hotkey monitor at each change). It
  calls HIToolbox's private `TISGetFnUsageType`/`TISUpdateFnUsageType`, looked up with `dlsym` in
  Carbon: what System Settings calls, which applies at once; writing `AppleFnUsageType` itself takes
  effect only at the next login. OpenWhispr (MIT) and Inputalk ship the same approach.
- The user's choice is saved in the app's defaults (`globeKeyActionBeforeFnHotkey`) before the
  setting changes, so a run that crashed is put right at the next launch: restored if fn is no
  longer the hotkey, still held if it is.
- The user's own later choice wins: the setting is put back only while it is still Do Nothing, and a
  choice made while the app was not running is the one saved. A user who chose Do Nothing already
  is never touched. A later choice of Do Nothing itself cannot be told from the app's own, so after
  a crash it is replaced by the saved choice.
- Settings says so under the hotkey picker, in place of asking the user to change the setting.

**Consequences:**
- A private API: if a macOS drops the calls, `System.live` is nil, the setting is left alone and fn
  still triggers the Globe action (logged). `theSystemCallsExist` fails first on such a macOS.
- The app changes a system-wide setting: while it runs with fn as the hotkey, the Globe key does
  nothing anywhere, including its double press for macOS dictation. An app deleted without quitting
  normally, or never launched again after a crash, leaves Do Nothing in place.
- Put back through `TISUpdateFnUsageType`, a choice that was macOS's computed default is now stored
  explicitly; it reads the same.
- The unit-test host never creates `GlobeKeyAction` (it is made after the XCTest guard), so a test
  run can never restore a setting the running app holds. (No test pins that placement: the SwiftUI
  delegate adaptor keeps the `AppDelegate` out of the test's reach, and so is the launch call to
  `connectHotkey`, like all wiring after the guard; the owner's use of fn exercises it.) Tests use a stand-in for the setting and only read the real one.
- Numbered 031: ADR-DESK-022 to 030 are taken by agent-tool branches not yet merged.
- Whether fn still reaches the event tap with Do Nothing selected is reported both ways online; the
  owner's manual test on this change settles it for the hotkey.

**Amendment 2026-09-27 (owner report: with fn, a double tap never went hands-free; Right Option's did):**
- Settled by a listen-only probe on the owner's MacBook keyboard, Globe action on Do Nothing: fn does
  reach the event tap (`flagsChanged`, key code 63), and each release from a tap is followed 0–3 ms
  later by a `keyDown` and `keyUp` of key code 0xB3, the Globe key's own, which Carbon has no name for.
  The gesture read that key-down as typing between the taps (ADR-DESK-021: typing breaks a double
  tap), so the second press started an ordinary hold. The app log showed it: "tap; waiting for a
  second press", then a new arming instead of hands-free, about 100 ms apart.
- `PushToTalkGesture.keyPressed` ignores that key-down while fn is the hotkey
  (`DictationHotkey.globeKeyCode`); both events still reach the app. `HotkeyMonitorTests` replays
  the recorded sequence. The owner confirmed the double tap with fn on a build with this change.
- The Electron app's `voice-hotkey` helper (ADR-DESK-032) carries the same skip and replay test.

## ADR-DESK-032: One Electron app for macOS, Windows and Linux

**Context:** Owner, 2026-09-27, after a study of OpenWhispr (MIT), which ships one Electron app on
all three platforms: "We should move to a unified one NOW (move mac to electron). mimic openwhispr,
don't reinvent the wheel. prefer ts over js." Then: "we should build our own app — our focus is
different. we hold the release until unification. Current feature parity must be matched before …
we're working towards using the Electron Mac app to replace the Swift one." Wayland may be tap to
start, tap to stop. The study and the phase plan are kept outside this repository.

**Decision:**
- `apps/desktop/` is one Electron app in TypeScript (strict `tsc`, eslint with zero warnings):
  Electron, React and Vite for the windows, Vitest for the tests, electron-builder for the packages.
  Our own app, not a fork of OpenWhispr; we copy its patterns.
- `src/core/` is the platform-free port of the Swift app's logic (the dictation controller, the
  gesture timing, the backend clients, the agent and its tools, tips, the welcome wizard, settings,
  the overlay geometry): no Node or Electron imports, so every OS runs the same code and Vitest
  tests it directly. The Swift app is its behavioral spec, as Thunderbird is iOS's (ADR-IOS-008);
  its tests were ported with it.
- What needs the OS is a **native helper executable** per role, spawned by the main process and
  spoken to over stdin/stdout, one JSON object a line (`{id, method, params}` → `{id, result}` or
  `{id, error}`; events as `{event, …}`; stderr lines `debug …`/`error …`, the debug ones kept only
  while the app writes its debug log). A helper exits when its stdin closes and is restarted after
  `helperRestartDelay` if it dies (`HelperClient`). On macOS the helpers are the Swift app's own code
  as a SwiftPM package (`native/macos`): `voice-hotkey` owns the keyboard event tap (it must decide
  within the tap whether Space or Escape is kept from the app, so the gesture runs there) and
  `voice-macos` the rest (paste and clipboard restore, the screen read, the caret, the keyboard's
  language, the Globe setting, the Accessibility activator, the email apps, Thunderbird). The
  Accessibility grant is expected to be the app's, macOS attributing a spawned helper's use of it to
  the app that launched it; the first manual pass on a packaged, signed build confirms it. Helpers are executables, not Node addons, so they need no rebuild per Electron version and can
  crash without taking the app down.
- The microphone is `getUserMedia` in a hidden window, into an AudioWorklet in an `AudioContext`
  at the recording rate (Chromium resamples), each chunk sent to the main process; each dictation is
  a session and the tracks are stopped when it ends. Only that window may use the microphone
  (`setPermissionRequestHandler`), and only for audio.
- The main process owns every model; each window draws the state it is sent and sends back commands,
  which are checked at the boundary (`isCommand`, `isAudioReport`). Every window is sandboxed with
  context isolation, no Node, no navigation and no new windows, under a CSP with no inline script.
- The session stays in the Keychain item the Swift app uses (`@napi-rs/keyring`), settings in a JSON
  file in the app's data folder, the debug log in `~/Library/Logs/TabMail Voice/`.
- macOS first, to the Swift app's parity; Windows and Linux follow with their own helpers. The
  public release waits for the Electron app, which then replaces the Swift app (`apps/macos/` is
  deleted then).

**Consequences:**
- A resident Electron app uses more memory than the Swift one; accepted by the owner's choice.
- Every Swift change merged before cutover must be ported too (the parity checklist in the plan).
- Wayland has no global key-up: tap to start, tap to stop there (owner, 2026-09-27).
- The first launch of the Electron build asks for access to the Swift app's Keychain item once, as
  the item's access list names the Swift app.
- The macOS helpers are built for Apple silicon only, as the Swift app is (Xcode 27 deprecates
  x86_64).
- Numbered 032: ADR-DESK-031 is the Globe key's, and 022 to 030 are taken by agent-tool branches not
  yet merged.

**Amendment 2026-09-27 (owner): a sign-out the credential store refuses.** The Swift app signs out
in memory and only logs a refused Keychain delete, so the old sign-in returns at the next launch
without a word. Asked, the owner chose "sign out, show a warning": `AccountModel.signOut` signs out
in the app first, then removes the saved sign-in; when the store refuses, its error says, in the
app's words, that the sign-in may come back at the next launch, and Settings shows it. A refused save (sign-in or refresh) fails with the app's own
message and leaves the account as it was, as the Swift store's throwing `save` does.

**Amendment 2026-09-27 (owner): Settings in a branded sidebar.** The Electron Settings page was the
Swift app's single grouped form on a flat gray; the owner found it "bland" and wanted it "themed and
look professional", and chose, from three looks, the branded sidebar. Settings is now a
System Settings-style window: a sidebar with the app icon, the account and five sections (Account,
Dictation, Agent mode, Permissions, General), the chosen section's cards beside it. It is in the
TabMail icon's blue → purple (`brand.ts`, as the overlay): the selected section, switches and the
default button carry the gradient, section icons the brand blue, and a red dot marks a section that
needs the user (signed out, a permission missing), in light and dark. White text sits on the
gradient darkened by `textShade`, so small text keeps WCAG AA's 4.5:1 along it, the account shows
in the text color (in the content and the sidebar), the notes and "Allowed" are darker than
`form.css`'s in light mode (its gray and green were under 4.5:1 on the window's color), and focus
is Chromium's own ring, the browser's default indicator (the brand blue's was under 3:1 on the light sidebar); under a Windows
contrast theme (`forced-colors`), which drops gradients, the switches are the system's checkboxes,
the chosen section is in the system's selection colors with its own focus ring in the text color
(the system's took no contrast with that fill) and the attention mark in the text color.
The page's transparency outranks `form.css`'s page color by specificity, since the build links the
shared `form.css` after `settings/index.css`: at equal specificity it painted over the frosted sidebar. On macOS the sidebar shows the
window's frosted material under inset traffic lights (`vibrancy: "sidebar"`); Windows and Linux draw
no material, so the window has its own color (`settingsWindowColor`). The settings and their
wording are unchanged (a test holds the notes to the Swift app's); the sidebar adds only its own
labels (the app's name, the account or "Not signed in", the attention mark's "Needs attention").
This departs from the Swift app's look only, which the Swift app keeps until cutover. Whether the
sidebar shows the frosted material with a clear `backgroundColor` but no `transparent` flag can
only be seen in the running app on macOS, not in the offscreen previews.

**Amendment 2026-09-27 (owner, trying the Electron build): "the startup is much slower … at least
2–3 seconds until the thing shows up … the awesome startup that Swift app has to be carried on."**
- Measured on the owner's Mac: the app's log gave the first audio 1.47–1.56 s after key-down (the
  Swift app: 0.59–0.62 s). A probe of the same `getUserMedia` call gave 0.4–1.3 s to open the device,
  up to 0.5 s to resume the context, then up to 0.45 s of digital silence before the first real
  signal, which is when the pill replaces the swirl. Chromium opens the device afresh for each
  dictation; nothing it offers keeps a device prepared with the microphone off. The overlay window
  itself paints 30–50 ms after it is shown, so it is not the cause.
- On macOS the microphone is now `voice-macos`'s, run as the Swift app runs it (`MicrophoneCapture`:
  an `AVAudioEngine` prepared ahead with the microphone off, started per dictation, discarded after
  it, rebuilt when the default input changes). It converts each buffer to mono float samples at
  `recordingSampleRate` and sends them as `microphoneChunk` events (base64 of little-endian floats),
  numbered by the app's session; `SessionAudioCapture` (formerly `WindowAudioCapture`) drives it
  through `MacSystem.microphone`, with the same sessions, start timeout and late-report dropping.
  The same probe through the helper: first audio 0.57–0.62 s, first real signal 0.67–0.9 s.
- Elsewhere the hidden audio window (`getUserMedia`) stays the microphone for now. The owner
  (2026-09-27): *"it is important that the dictation part and everything as you did right now
  remains native so that it's super fast … this needs to be done for other platforms as well"*: the
  Windows and Linux helpers take over the microphone, hotkey and paste when those platforms are built.
- The helper runs under the app's microphone grant, as its Accessibility use does; packaged, it
  inherits the `audio-input` entitlement (`entitlementsInherit`). A restarted helper is prepared
  again (`macHelper.onStart`).
- A helper that exits mid-dictation takes the microphone with it (the Swift app has no such case: its
  microphone is in-process). Asked, the owner chose *"send what was said"*: `macHelper.onExit` makes
  `SessionAudioCapture.lost()` tell the started session, and the controller finishes the dictation as
  at the length cap, transcribing what was heard; lost during the release tail, the tail's end
  transcribes it; lost before the hold is deliberate, it fails as the microphone does. A start still pending when the helper exits fails through its request, as before. What was said
  is then pasted through the restarted helper (agent mode's Edit and Compose first check the app in
  front, a request that fails during a restart as "you switched apps"; after a loss their backend
  calls outlast the restart): the paste carries its dictation's `AbortSignal`, and a
  request with one made while the helper restarts (from `onExit` on, the restart being due first)
  waits for it within its own timeout; one that times out, or whose dictation is canceled, while it
  waits is never sent (a canceled dictation pastes nothing). Every other request fails at once
  during a restart, as before.
- The helper's engine stopping by itself mid-dictation (AVAudioEngine stops on a configuration
  change: the input's sample rate or channels changed) is the same loss: `MicrophoneCapture`
  watches each engine for `AVAudioEngineConfigurationChange` from before it starts (weakly, so the
  notification's queue never holds the engine's last reference), stops that session
  (`MicrophoneSessions.lost`, like a failed start) and emits `microphoneLost {session}` after the
  chunks already queued; the app reports it as `lost`, and the controller sends what was said, as
  above. One arriving while the start is still pending fails that start. (The Swift app does not
  watch for this; its dictation keeps listening to a stopped engine.) The audio window's path
  (Windows, Linux) does not report it yet.
- `MicrophoneSessions` treats a failed start like its stop (no older session starts after it), and
  the whole-number request params (session, pid, Globe value) are read with `JSON.integer`, the
  restore delay rounded to whole milliseconds with `Int(exactly:)`, so a malformed number is refused
  rather than trapping the helper. Engine release has no hardware-free test: the owner declined a test-only
  engine seam in `MicrophoneCapture` (no production complication for test convenience); the release
  decision itself is `MicrophoneSessions`', which is tested.

**Amendment 2026-09-27 (owner): the Swift app removed.** *"Once everything is clean … clean up the
non‑Electron version so that we don't have dead weight being carried over."* With the Electron app's
parity branches merged (the native microphone, the branded Settings, the overlay's swirl and icon,
the hands-free tip and fn double tap), `apps/macos/` is deleted, together with what only the Swift
app used: `Scripts/copy-worktree-secrets.sh` and the signing-config template (the Xcode project read
its `DEVELOPMENT_TEAM`; the Electron app signs through electron-builder from the keychain). The
gitignore keeps ignoring the local signing config, so a copy left in a checkout is never committed.
The native helpers in `apps/desktop/native/` stay: the dictation path stays native. The Swift app's
source stays in git history (the parent of this change) and in the unmerged Swift agent-tool
branches, which remain the reference for porting agent mode. The docs describe the Electron app
only; code comments that name the Swift app record what a port matches.

## ADR-DESK-033: The bubbles surround the pill, one for each app Answer reaches

> ⚠️ **Placement SUPERSEDED by ADR-DESK-036 (owner 2026-09-28):** one row under the pill (over it
> without room), four at most, the latest to run first, replaces the rows around it
> (`bubbleCenters`, `agentBubbleRowCapacity`, `agentBubbleRowsAbove`). An app's bubble now circles
> while its tools run. One bubble per tool and per connector switched on stands.

**Context:** Owner, 2026-09-26: "many bubbles surround the pill": the single row above the pill fills
first, then the bubbles wrap around the pill's sides and underneath, keeping clear of the caret's
line. Owner, 2026-09-27: each connector switched on gets its own bubble ("Connector bubbles"). First
built in the Swift app (its ADR-DESK-031 there, on the unmerged agent-tool branch); built here in the
Electron app (ADR-DESK-032), numbered 033 as 031 is the Globe key's.

**Decision:**
- Beside the tools' bubbles (`DictationController.tools`), agent mode shows one for each connector
  (`DictationController.connectors`) switched on at key-down whose tools this computer has, while
  Answer, whose loop runs them, is offered; with Answer off, none. The connector's icon, never drawn
  as running (its tools' progress shows in the chat window, ADR-DESK-023); it fades while a tool
  runs, as the idle tools' bubbles do. One `Bubble` draws both.
- `bubbleCenters(pill, sizes, underFits)` places them in order: a row of up to
  `agentBubbleRowCapacity` (5) centered over the pill (with no more bubbles than that, the row as
  before); then one beside the pill on the left and one on the right; then rows under the pill. When
  they don't fit under it (`bubblesFitUnder`: the pill opened above the caret's line, or sits too near
  the work area's bottom for a row and the tip under it), the later rows go over the first instead,
  so none covers a caret's line under the pill. The overlay window works this out as it places the
  pill, and the view is told (`OverlayState.bubblesFitUnder`).
- A tip under the pill goes under any bubbles under it (`underBubbles`); the hands-free tip over the
  pill (ADR-DESK-021's amendment) goes over them all, as before. The canvas grew to room for two
  rows and a tip over the pill (`agentBubbleRowsAbove`), the pill still centered in it.

**Consequences:**
- With every tool offered at once (three) and every connector (eight since Shortcuts was retired,
  ADR-DESK-029; nine before) on, eleven bubbles: five over, two beside, four under (or a second row
  over).
- A pill below the caret still has its first row over the caret's line, as before; only the rows
  after it keep clear of it.
- A thirteenth bubble (two more connectors) would start a third row: the geometry test, which places up to
  every tool and connector, checks they stay inside the canvas.

## ADR-DESK-034: A bubble under the pointer grows and says what it is

> ⚠️ **Amended by ADR-DESK-036 (owner 2026-09-28):** bubbles grow about their center, not up from
> their bottom edge, to fixed sizes (`agentBubbleHoverDiameter`, `agentBubbleRunningDiameter`), from
> a smaller size at rest.

**Context:** Owner, 2026-09-28: "for the tools, when mouse hovers over them, make them sort of
enlarged and also show tooltips on what this tool is. Sort of something that you can even inspect."
The overlay lets every click through (ADR-DESK-022) until the chat window opens, so the page saw no
pointer at all.

**Decision:**
- The overlay window ignores the mouse with `forward: true` (`Windows.overlay`, and again as the
  chat window closes): clicks still pass through to the app under it, but the pointer's moves reach
  the page, which is all a hover needs. The window stays unfocusable, so hovering takes no focus.
- A bubble under the pointer (a tool's or an app's, ADR-DESK-033) grows to `agentBubbleHoverScale`
  upward from its bottom edge, as a running one does (a running one keeps its own, larger scale), and
  shows in full even while faded for another tool's run.
- Its tooltip names it and says what it does, in the words Settings uses (`settingsDescription`),
  drawn as the tips are. It goes over the bubble as grown (`grownBubble`), `bubbleTooltipGap` clear,
  or under it when the canvas has no room over it, moved in from the canvas's edge when centering
  would leave it (`bubbleTooltipCenter`); it is hidden until measured and lets the pointer through,
  so it never takes the hover from the bubble under it.

**Consequences:**
- Hovering needs no click and moves no focus, so it works mid-hold without disturbing the dictation.
- Electron forwards the pointer's moves on macOS and Windows only: on Linux the bubbles show no
  hover. On Windows forwarding is a system-wide low-level mouse hook, kept while the overlay is
  hidden, and Electron has open reports of forwarding making the cursor or other windows flicker
  there (electron#35030, #35414, #48035); worth forwarding only while the overlay shows once the
  Windows helpers exist.
- The hover follows the bubbles: one that goes (Space back to dictation) takes its hover with it, and
  each bubble's tooltip is measured afresh, never shown at the last one's size.
- A tooltip can cover other bubbles, the pill or a tip while it shows; it is drawn over them.

## ADR-DESK-035: Agent mode sends the user's name, set in the wizard or Settings

**Context:** Owner, 2026-09-28. In a direct-message chat the user asked agent mode to relay a message
to the other person ("tell him…"); Compose wrote the reply as the other person, greeting the user by name. The request
carried the window title, the screen (messages under both people's names) and the request, but
nothing said who the user is, so the backend's model could not tell the user's own messages on screen
from the other person's. Thunderbird's compose prompt has always had the user's name. The owner:
"send the macOS full name or the username, but a more natural way is to have it in the setup wizard",
and, when it is not set, a tip in "a neutral, inviting way"; "if it's not set, it's fine, but it's a
sort of nag to set it in the wizard and settings".

**Decision:**
- A stored setting, `AppSettings.userName`: null until the welcome wizard or Settings stores one,
  empty when the user cleared it, kept as typed and sent trimmed (`sentUserName`). It is part of the
  dictation's settings snapshot (`DictationSettings.userName`).
- The welcome wizard has an "About You" step after consent, with a name field offering the computer
  account's name (`suggestedUserName`): on macOS the account's full name from `voice-macos`
  (`fullUserName`, `NSFullUserName()`), else its short name (`os.userInfo().username`), the only name
  elsewhere. Next without editing keeps the offered name; a name typed, or one cleared, stays as the
  user left it. Nothing else stores the offered name.
- Settings › Agent mode has the same field, empty with the offered name as its placeholder while none
  is set, and a note inviting one; the section is marked for attention until a name is set.
- While no name is set, switching to agent mode shows a tip by the pill (`setName`: "Add your name in
  Settings so agent mode knows which messages are yours"), every time, until a name is set; switching
  back to dictation takes it away. Hands-free, it takes the hands-free tip's place for its display
  duration, and the hands-free tip returns after it. A follow-up in the chat window shows no tips, as before.
- Every tool's request (edit, compose, thunderbird, answer) sends `user_name`, empty when none is set
  (the backend leaves a missing variable in the prompt as written). The choice of tool sends none. The
  backend's prompts say text on screen under that name is the user's own, and Compose that a relayed
  request ("tell him…") is a message from the user to that person (backend ADR-023 amendment).

**Consequences:**
- The name leaves the computer only with agent mode's requests, and the backend does not store it.
  Dictation's cleanup does not send it.
- A user who finished the wizard before this step (the app has not shipped) has no name set, sees the
  tip in agent mode and the mark in Settings until they set one.
- A name that matches none of the names on screen (a nickname, another spelling) helps less; the
  prompt reads "that name, or part of it".

## ADR-DESK-036: The chat window opens over the pill; the bubbles are a history of what ran

**Context:** Owner, 2026-09-28, reading an agent-mode answer session's log: "the answer box [should]
appear above the … voice pill … and close the other tools"; "while the chat is running, I don't see
the circle running and executing tools"; "we want the tools to appear below the … voice pill … only
show like three or so, and it just fades away to the right … sort of alphabetical … the most recent
run tool just appears on the left … shifting the other tools to the right"; the Settings tools page
sorted alphabetically; "the answers being shown are … pretty rough … look at Thunderbird and how the
text appears … and mimic that"; and some turns seemed "not in turn". Asked, the owner chose a small
resting circle for the pill between follow-ups, and, for an unclear request in agent mode, "have a
prompt to ask the user". Later the same day: a gray request bubble "looks bad"; "make the … neon glow
very apparent for the pills … a hint that we're in agent mode, only for the pill"; the pill should
circle while agent mode works; a bubble "slightly smaller than the pill" at rest but as large as
before when grown; and "4 entries tops". The log showed three causes: the chooser pasted a spelled-out
name as Compose text into the app instead of continuing the conversation; the answer asked instead of
acting on a correction; and the web search, run on the backend inside a round, showed nothing, since
the stream was read whole and named its tools only in development builds.

**Decision:**
- **Placement.** The pill stays where the overlay put it for the caret, or for the pointer without
  one (`pillPosition`; the pointer's spot is kept, so the chat opens there even if it has moved). The
  chat window opens `chatPillGap` over the pill and its bubbles (`chatStripHeight`), or under them
  when the tallest window would not fit over them but would under them; on a screen too short for
  either, on the side with more room, growing no taller than that room and scrolling instead
  (`chatSide`, `ChatPlacement.maxHeight`), so all of it, a question's buttons too, stays on screen.
  The side is decided once, so it never flips as the chat grows. The overlay window is laid out by
  `chatWindowFrame`, keeping the edge on the pill's side fixed as it fits the chat's height, so the
  pill never moves; its bubbles keep the side they had
  (`ChatPlacement.bubblesUnder`). The view is told where the pill is across the window
  (`ChatPlacement.pillX`). The window takes the mouse over all of it while the chat is open, as
  before; the pill's layer lets the pointer through to the chat but for its bubbles.
- **One tree.** The overlay page renders the pill in the same place in its tree with the chat window
  open or not, so the pill and its bubbles don't remount as the chat opens. The chat appears once,
  fading in as it rises `chatAppearRise` from the pill and scales up from `chatAppearScale` over
  `chatAppearDurationSeconds`. Under it the pill rests as a circle with a fainter sparkle
  (`agentRestingSymbolOpacity`) while nothing runs, listens for a follow-up without the warm-up
  swirl, and keeps the last request's bubbles until a follow-up knows its own.
- **The row.** Bubbles go in one row under the pill (over it without room, `bubblesFitUnder`), a
  `agentBubbleGap` from it and `agentBubbleSpacing` apart (`bubbleRow`): the first
  `agentBubbleRowVisibleCount` (3) centered on the pill in full, then `agentBubbleRowFadeCount` (1)
  fading away to the right (`bubbleRowOpacity`), four at most. Their order is `bubbleOrder`: those
  that ran, the latest first (`DictationController.recentBubbles`, `ranNow`: the tool the agent
  chose, then the app whose tool starts), then the rest alphabetically by name (`alphabetical`). The
  history lasts the app's run, in memory only. A bubble slides to its new place over
  `agentBubbleMoveDurationSeconds`.
- **Running.** A bubble circles while its tool runs, and an app's while one of its tools runs: a
  `ConnectorTool` here, or a server tool of the app's (`serverToolConnector`: the web's `search_web`)
  inside a round, one at a time as the answer's tools run in turn
  (`DictationController.runningConnectors`, cleared at teardown). The pill circles while agent mode works (`running`). Bubbles are
  `agentBubbleDiameter` (20) at rest, smaller than the pill, and grow about their center to
  `agentBubbleHoverDiameter` or `agentBubbleRunningDiameter`, as large as before; neighbors both
  running don't touch.
- **Agent mode's pill.** In agent mode (and under the chat window) the pill glows as neon, a tight
  blue glow in a wide purple one (`agentPillGlow…`); dictation's pill and every bubble keep the plain
  glow. *Amended 2026-09-29:* the owner found the blue and purple neon "not as apparent" beside
  dictation's own blue and purple glow and, from eight colors rendered side by side and then seen
  live, chose red-pink: a tight `#FF2D55` glow in a wide `#FF006E` one (`agentPillGlowInnerColor`,
  `agentPillGlowOuterColor`), the one color in the overlay outside the brand's.
- **Server tools as they run.** `HTTPRequest.onChunk` hands the completions stream to `SSEParser` as
  it arrives (a piece may end anywhere, a CRLF split across two included), and `Completions.round`
  reports each `tool_started`, `tool_completed` and `tool_failed` event that names its tool
  (`ServerToolEvent`); the chat shows a named tool's label while it runs. The backend now names the
  tool in production too, for every client (its ADR-023 amendment of 2026-09-28, deployed before this
  build; an event without a name is skipped, so an older backend shows no progress, as before). Its
  arguments and result stay development-only.
- **Replies as Thunderbird shows them.** A reply is laid out in blocks (`replyBlocks`: paragraphs at
  blank lines, each line break a line; bulleted and numbered lists, numbered from where they start,
  an unmarked line continuing an item; `#` headings), each line's inline Markdown as before, and
  revealed as TabMail's chat in Thunderbird reveals one: a line or list item every
  `chatRevealStepInterval` (100 ms), each fading in over `chatRevealFadeDuration` (180 ms) as it rises
  `chatRevealRise`, the newest kept in view unless the user scrolled up. Line height and paragraph
  spacing are Thunderbird's (`chatLineHeight`, `chatParagraphSpacing`). The request sits on the right
  at most `chatRequestMaxWidthFraction` of the width, as there, but in a light tint of the brand's
  gradient with a hairline brand border rather than gray. While a request waits with nothing else
  to show, the window says `chatThinkingLabel`.
- **Settings** lists the tools and apps together alphabetically (`alphabetical`). The welcome
  wizard keeps its own order.
- **Unclear requests** (backend ADR-023 amendment, 2026-09-28): the chooser picks Answer for an
  unclear request, a bare name, a spelling or a reply to the last answer's question, and never
  guesses text into the app; the answer carries a reply or correction on into the request before it,
  and asks one short question when still unclear.

**Consequences:**
- The pill never jumps as the chat opens or grows, and the caret's line stays clear of the chat, which
  opens away from it.
- A follow-up's pill listens in place under the chat instead of in a status pill inside it; a
  follow-up's phase changes show nothing new in the chat, so they no longer scroll it.
- Only four bubbles show: with more tools and apps on, the rest show once they run.
- A server tool's progress needs the backend deployed first; the Voice app tolerates an older one.
- The reveal starts again for a reply whose turn remounts (it doesn't while the chat stays open).
- Shown once measured (amended, owner, 2026-09-30: no blink "for the agent answer tool"): the overlay
  window is transparent (`setOpacity(0)`) from `showChat` until the chat's first measured height
  (`fitChat`), and opaque again if the chat closes first, so the window resized for the chat never
  shows the pill out of place for a frame before the page lays the chat out. The pill is not drawn
  for those few frames.


## ADR-DESK-037: The Thunderbird tool is off until its native connector

**Context:** Owner, 2026-09-29: "we should actually disable the Thunderbird tool so that we can test
all the others. And then for the Thunderbird tool, we should only use it … after introducing the
native connector, because right now it's just clunky." The tool drives TabMail's chat in
Thunderbird from outside (ADR-DESK-014's spike: shortcut, paste, Return). The native connector is
ADR-DESK-014's option B, a native-messaging bridge to the add-on, being built separately.

**Decision:**
- `offeredAgentToolIDs` (Edit, Compose, Answer) is what agent mode offers and what Settings and the
  welcome wizard list; `agentTools` stays the registry of every tool, Thunderbird's included, so a
  bubble or a stored switch still names a tool (`isAgentToolID`). `AppSettings.enabledTools` is drawn
  from `offeredAgentToolIDs`, so no dictation offers Thunderbird's tool, and the agent is never told of
  it (`available_tools`).
- Its switch, and Settings' Email app menu (which only chooses where that tool sends), are hidden. A
  switch the user stored for it is kept, for when it returns.
- Its code stays (`ThunderbirdTool`, `ThunderbirdRelay`, the email app's resolution and icon), and
  the controller's tests still run it with a tool list that offers it.

**Consequences:**
- Mail and calendar requests go to Answer, whose Calendar, Reminders, Email and other connectors
  carry them out; the backend's agent prompt says which requests each tool takes (ADR-023
  amendment, 2026-09-29).
- Bringing the tool back is offering it in `offeredAgentToolIDs`, with the native connector as its
  delivery. Settings' tests of the Email app menu (its choices, and its three notes by email-app
  case) were taken out with it and come back from this change's history.

## ADR-DESK-038: A dictionary of the user's words, typed or learned from their corrections

**Context:** Owner, 2026-09-29: dictation should learn the user's vocabulary, as other dictation apps
do, with a dictionary the user also edits by hand, in its own Settings section. A live test the same
day showed the speech model spells made-up names right when given them as a word list, and that a
name in Hangul is left in Hangul, so the cleanup pass must see the words too (backend ADR-025). The
consent step is reworded, not re-asked (owner: the app has never been released, so no one has
consented to the old text). Later the same day, the owner: don't rely on the dictionary alone, but
leave half of the backend's 200 words to names and uncommon words picked from the context, "a dynamic
dictionary being constructed on the fly from the captured context", by rules on this computer, not a
model; TabMail on iOS does the same (its ADR-IOS-086).

**Decision:**
- `AppSettings.dictionary`: entries `{word, learned}`, in the order added, kept on this computer, not
  synced. Words are trimmed with their spaces collapsed, and must pass the backend's rules
  (`dictionaryWord`, in the backend's units: UTF-16 code units, JS `trim`, words split on spaces): at
  most `dictionaryWordMaxChars` characters and `dictionaryWordMaxWords` words, no control characters
  or `<` `>`, at most `dictionaryMaxEntries` (100) words, half the backend's 200, so all of them are
  always sent; the same word in another case is one entry, spelled as the user last typed it. A word
  the backend would refuse is never stored, so no dictation fails on one.
- The dictation's key-down snapshot (ADR-DESK-017) carries the words and the learning switch. Every
  transcription sends them as `vocabulary` (none when empty), and dictation's cleanup as `dictionary`,
  one per line. Agent mode's prompts don't take them.
- Screen terms (`contextTerms`): the transcription's `vocabulary` also carries up to
  `contextTermsMax` (100) names and terms from the key-down screen read (window title and rendered
  text), after the dictionary's words, when the read is already done as the recording is sent (it
  never waits for one) and screen reading is on. A term is a word with a capital letter inside it
  ("TabMail", "OKR", "iOS"), or at its start where no sentence starts (a line's start or after `.`
  `!` `?` starts one); a run of them is one term ("Kaelthorne Drake") up to `dictionaryWordMaxWords`
  words, split by punctuation after a word or before one ("Xyvora (Brevalle Labs)", a link's `[`), a longer run (a heading) counting word by word; not an everyday word
  (`correctionCommonWords`), a word under `correctionMinWordLength`, an address (`@`, `://`), or a
  word `dictionaryWord` refuses; none the same as a dictionary word; the most frequent first, then
  the earliest. The cleanup does not get them: it reads the screen itself.
- Settings › Dictionary: a field to add a word, the words with a Remove button each, a learned one
  tagged "Learned" (typing it makes it the user's own), and "Learn from my corrections" (on by
  default) where the field can be read: macOS.
- Learning (`CorrectionWatch`, `learnedCorrections`, our own implementation of the approach of
  OpenWhispr's `correctionLearner` (MIT, https://github.com/OpenWhispr/openwhispr), credited in
  `corrections.ts` and the README; no code copied): after a dictation's paste, with learning on at its key-down, `voice-macos` reads the
  focused field of the app that was in front at key-down (`focusedFieldValue`) every
  `correctionPollInterval` for `correctionWatchDuration`. The first read holding the pasted text is the
  field before any edit; each later change that stays for one interval is compared with it, and the
  words the last one teaches are learned when the watch ends (the next key-down, its duration, or a
  field it can't read), so a pause in the middle of an edit ("tabmail" on the way to "TabMail")
  teaches nothing. A change that respells something new, or has the pasted text back as it was (an
  undo), replaces what an earlier one taught: with what it teaches once it has stayed, with nothing
  before, so a spelling paused on and then changed teaches nothing though the message is sent before
  the change stays. A change that respells nothing (a field emptied by sending the message, another
  field focused, a word half retyped) keeps the correction. The
  changed span (common prefix and suffix) must lie within one copy of the pasted text; the words are
  aligned (longest common subsequence), and a run of changed words is learned when it respells rather
  than replaces: at most half the dictation's words changed, an edit distance within
  `correctionMaxEditShare` of the longer spelling, not another form of a lowercase word (only its end
  changed past `correctionMinStemShare` of its start: "report" → "reports", "send" → "sent"; a
  capitalized name or a script without case is exempt), not an everyday word or one shorter than
  `correctionMinWordLength`, and for a change of case alone, a capital inside a word or a change of
  spacing ("tabmail", "tab mail" → "TabMail"), not one at a word's start. The next key-down stops the
  watch first, so a dictation's own paste is never taken for a correction; an unreadable field ends it.
- The helper never reads a password field (`kAXSecureTextFieldSubrole`) or a field longer than
  `correctionMaxFieldLength`. The field's text stays on the computer and is never logged; the debug
  log sees only the words learned (`log.content`).
- The consent step lists the dictionary's words among what a dictation sends, and says learning reads
  the field on this computer and can be switched off.

**Consequences:**
- A word removed from the dictionary can be learned again from a later correction.
- A lowercase term the speech model gets right at its start but wrong at its end ("kubctl" for
  "kubectl") is not learned; the user adds it by hand.
- Windows and Linux have the dictionary but no learning until their helpers read the field.
- No notice when a word is learned yet: the user sees it in Settings (an overlay "Learned … Undo" is a
  follow-up), and the privacy policy's Voice Data wording is updated separately.
- Every word is sent with every dictation: the list's cap keeps that small.
- The screen terms leave the computer only as words picked from a screen the consent already covers
  sending. The picking is heuristic: a capitalized ordinary word mid-sentence ("Monday") is sent too,
  harmlessly, since the list only biases the speech model; a name only ever at a sentence's start is
  missed. At 200 words of up to 6 each, the list could pass AssemblyAI's 1,000-word total should the
  backend fall back to it (its ADR-025).

## ADR-DESK-039: A shorter wait between the release and the text

**Context:** Owner, 2026-09-29: two to three seconds passed between letting go of the key and the
text appearing. Measured end to end the same day (the app's log against the backend's per-request
timeline, the Mac's clock corrected): the app itself adds nothing after the reply (the paste starts
in the same millisecond), so the wait was the release tail (300 ms), the connection and upload
(45–175 ms), the backend's sign-in, entitlement and quota checks (about 90 ms, but 365 ms on the
first dictation after a pause), the transcription (250–700 ms) and the cleanup (300–470 ms). One
dictation that day failed outright: the speech model's provider answered 429 (rate limited), the
backend passed it on as a 502, and the recording was lost. The owner approved all four changes below,
and asked that a server error be retried with a note on the pill, "so that the user doesn't have to
say it again". Before the audio was compressed, the owner asked whether compressing would itself add
time; measured first (below).

**Decision:**
- **Warm-up at key-down.** Every hold sends `GET /whoami` with the sign-in
  (`TranscriptionClient.warmUp`, under `withFreshToken`) while the user speaks, so the transcription
  after the release finds the connection open, the token refreshed if it was about to expire, and the
  backend's token check and entitlement warm. Best effort: nothing waits for it, and a failure is
  logged only.
- **FLAC upload.** The recording is uploaded as FLAC (`format: "flac"`, which the backend already
  accepted), lossless, at about half WAV's size. `FLACEncoder` (in `src/core`, no dependency) encodes
  each 4,096-sample frame (256 ms) as the audio arrives, so the release leaves only the last partial
  frame to encode. Measured before it was adopted: the whole recording takes about 1.4 ms per second
  of audio to encode (10–18 ms for 7 s, 160 ms for 120 s), against about 90 ms of upload saved for
  7 s and 1.5 s for 120 s on the owner's connection; encoding while recording removes even that cost.
  *(Later (ADR-DESK-040): the recording is peak-normalized first, which needs all of it, so it is
  encoded at the release, about 10 ms for a typical dictation.)*
  The reference `flac` decoder gave back the exact samples. The debug "Play Last Recording" file
  stays WAV.
- **Retry on a server error.** A transcription that fails with a 5xx (the speech model behind the
  backend rate limited, overloaded or failed) or a dropped connection is sent again after
  `transcriptionRetryDelays` (0.5 s, then 1.5 s), the same recording and request, while the pill
  shows "Server error, retrying…" (the `retrying` phase), back to transcribing once a retry
  answers; after the last it fails with the server's error as before. Nothing else is retried:
  signed out, no subscription, over quota or throttled (the backend's own 429), a refused request,
  or a timeout, here or the backend's own 504 (either already waited: `transcriptionRequestTimeout`,
  or the backend's 30 s for the speech model; retrying a 504 would hold the hotkey for 1.5 minutes). Canceling during the wait sends nothing more. Both modes share it,
  since agent mode's request starts with the same transcription.
- **Release tail 150 ms** (was 300 ms), owner's choice.

**Consequences:**
- Every hold, a tap included, sends one small `GET /whoami`. For a user without an entitlement it can
  grant the signup trial, as the transcription request it precedes would.
- Node's `fetch` closes an idle connection after 4 s, so a dictation longer than that may upload over
  a new connection; the backend's warmth outlasts it.
- A retried request whose first attempt did reach the model but lost its reply (a dropped connection
  after the backend answered) is transcribed, and counted, twice. A 5xx is never counted: the backend
  reports usage only on success.
- Supersedes ADR-DESK-005's "A failed transcription loses that recording (no retry queue yet)" for
  server errors; its WAV upload is now FLAC.

## ADR-DESK-040: The recording is peak-normalized before it is uploaded

**Context:** Owner, 2026-09-29, after a speech-to-text comparison (`Scripts/stt-compare`, the 10
recordings of `passages.txt`, 3 runs each, word error rate after the Whisper English text
normalizer): the recordings, made on a Mac's microphone with no automatic gain (the app turns it off,
as OpenWhispr does), peak at only −22 to −29 dBFS. Scaled so their loudest sample sits at −3 dBFS,
the backend's model (MAI-Transcribe-2) made 9.5 % word errors against 11.0 % as recorded, and one
Whisper Large V3 host that dropped most quiet speech as silence (79 %) came down to 19 %. The owner
asked for the same boost in this app and the iOS app. OpenWhispr's desktop app sends its recording
unscaled; its mobile app asks its own server to normalize.

**Decision:**
- `AudioRecorder.finish` scales the whole recording by one gain so its loudest sample sits at
  `normalizedPeakDecibels` (−3 dBFS; the headroom keeps any sample from clipping), boosting by at
  most `maxNormalizationGainDecibels` (30 dB, so near-silence isn't raised into loud noise; the
  quietest measured recording needed +26 dB) and never cutting a louder one (`normalizePeak`).
- Peak normalization, one gain for the whole recording: the transform that was measured, and it
  changes nothing but the level. Not automatic gain control (the microphone's own stays off: on
  Windows Chromium's changes the system input volume, as OpenWhispr found), and not loudness
  (RMS/LUFS) normalization, which would need a limiter to keep peaks from clipping.
- The FLAC upload is therefore encoded at the release instead of while recording (ADR-DESK-039):
  about 1.4 ms per second of audio. The debug "Play Last Recording" file and `Recording.pcm` are the
  normalized samples, what the backend hears. `peakLevel` stays the level as captured; the debug log
  adds the gain.
- The iOS app does the same (its `AudioRecorder`), with the same two values.

**Consequences:**
- About 10 ms more between the release and the upload for a typical dictation (160 ms at the 120 s
  cap).
- One loud click (a key press) sets the gain, so a recording with a click louder than the speech is
  boosted less. The measured gain came from speech-only recordings.

## ADR-DESK-041: The app updates itself from cdn.tabmail.ai

**Context:** Owner, 2026-09-30: 0.1.0 shipped with no way to update but downloading it again. The
native-FTS host updates itself with its own Ed25519 signing key and a signed manifest, because
nothing else vouches for its download. The owner asked whether Voice needs the same, and chose both
behaviors offered: download quietly and install at the quit, and ask to restart once it is ready.
Hosting: GitHub releases were the simpler option, but every installed app would then contact
GitHub, a recipient the records of processing and the privacy policy don't name. TabMail's own CDN
(Cloudflare R2, `cdn.tabmail.ai`, where the Thunderbird add-on and native-FTS updates already come
from) adds none, so the owner chose R2 (2026-09-30). The owner also asked that an update check send
no user data.

**Decision:**
- `electron-updater` (electron-builder's own), with the `generic` provider:
  `electron-builder.json`'s `publish` is `https://cdn.tabmail.ai/releases/voice/macos-arm64`, so the
  packaged app carries `app-update.yml` and reads `latest-mac.yml` there, and nowhere else. Each
  release uploads the versioned ZIP and its blockmap, the DMG, and `latest-mac.yml` last, so the
  feed never names a file not yet there. The ZIP's name has no spaces (`artifactName`).
  `useMultipleRangeRequest` is off: the CDN answers a request for several byte ranges with 400, so
  a differential update (only the blocks that changed, from the blockmaps) asks for one range at a
  time instead of falling back to the whole ZIP.
- The DMG's name carries no version (`TabMail-Voice-latest-arm64.dmg`, as the build names it, so the
  build, the CDN and the website agree): each release replaces it, so the website's download button
  links to it and serves the newest release without an edit per release (owner, 2026-09-30). A
  versioned copy is kept beside it. The first name, `TabMail-Voice-arm64.dmg`, is retired: the CDN
  served that object unreliably, and a fresh name was the fix.
- The DMG window has our own background (`resources/dmg-background.png`, at 1x and 2x): white with
  the arrow, and the app and the Applications link in its top half. Its title, the volume's name, is
  "TabMail Voice", without the version. The window is the background's size, and
  Finder's path and status bars cover its bottom; with the stock layout's icons lower down, the
  window scrolled on a Mac with those bars on.
- Nothing about the user or the installation is sent: `electron-updater` keeps a random ID for the
  installation (`.updaterId`, for staged rollouts, which we don't use) and sends it as
  `x-user-staging-id` with every request; `Updater` sets that header to a constant
  (`updateRequestHeaders`), which the library merges over its own. A request carries the IP address
  and user agent any download does, and the generic provider's random `noCache` query.
- Uploaded twice (owner, 2026-09-30): the GitHub release also carries a copy of the DMG (versioned),
  the ZIP and `SHA256SUMS`, for anyone who wants them from the source. The app and the website
  download and update from the CDN alone; the feed is not put on GitHub.
- No update key of our own on macOS: Squirrel.Mac installs an update only if it carries the running
  app's Developer ID signature (its designated requirement), and the feed's SHA-512 covers the ZIP.
  Someone who could write to the CDN can't ship a build we didn't sign, nor roll the app back to an
  older signed one: `ElectronSquirrelPreventDowngrades` in `Info.plist` makes Squirrel.Mac refuse an
  update whose own `CFBundleShortVersionString` is lower than the running app's (the feed's version is
  the writer's to choose; the bundle's is signed). Squirrel then also refuses any version not of the
  form x.y.z, so releases keep plain x.y.z versions (no pre-release suffix); the release script
  checks it.
- `Updater` (`src/main/updater.ts`), packaged builds only: looks `updateFirstCheckDelay` after launch
  and every `updateCheckInterval`, downloads by itself (`autoDownload`), installs when the app quits
  (`autoInstallOnAppQuit`). An update is ready only when Squirrel.Mac (Electron's own
  `autoUpdater`) says `update-downloaded`: `electron-updater`'s event of that name comes before
  Squirrel has fetched the ZIP from it, let alone checked its signature, so an update Squirrel then
  refuses would have been offered and Restart Now would do nothing. Once ready it asks once per
  version "Restart now?", on a task of its
  own (the dialog is modal and holds the main process: never inside a dictation's phase change),
  never while a dictation runs or the chat window is open (it waits for `appIsFree`). Later is both
  the default and the cancel button: Return, typed as the question appears, does nothing, and
  Escape picks Later. The menu shows Check for Updates…, what a check is doing, or Restart to Update
  once one is ready; Settings › General shows the same as a button under the version (owner,
  2026-09-30). A downloaded update stops further checks until the quit installs it.
- Its errors log their type and `electron-updater`'s code through `log.error`; the library's own
  logger is off (it writes to the console).
- Released with `tabmail-release-helpers/voice/release-mac.sh` (skill `tabmail-voice-release`):
  electron-builder notarizes and staples the app before it zips it (`APPLE_KEYCHAIN_PROFILE`), so the
  ZIP and the feed's hash are the published ones; the DMG is signed, notarized and stapled after, and
  the feed rewritten with its final hash.

**Consequences:**
- 0.1.0 has no updater: its users download 0.1.1 once by hand; every release after reaches them.
- Windows (NSIS) and Linux (AppImage) can use the same kind of feed when their targets exist;
  without Authenticode signing a Windows update is vouched for only by the feed's hash, and a
  `.deb`/`.rpm` install is updated by its package manager instead.
- An app run from the mounted DMG, or from a folder the user can't write, can't be replaced: the
  update is refused, so it is never offered, and each check tries again. The owner accepted this
  without telling the user (2026-09-30): the disk image's window shows where the app goes.

## ADR-DESK-042: The text goes where the caret was at key-down, or onto the clipboard

> **Amended (owner, 2026-09-30, same day): only the app is checked.** Tested on a dev build in
> iTerm2, every dictation was copied as "Cursor moved" though nothing had moved: iTerm2's caret is a
> position in its whole scrollback, which drifts with every line of output (a TUI's spinner), and it
> accepts a selection set but ignores it, the cursor being the program's. Owner: "just checking if
> focused app changed should be what we do since that one is robust but not others", with "a 'check
> if focus changed' function" wired in. So:
> - The controller keeps the app in front at key-down (`targetApp`, as before this ADR) and, before
>   each paste, dictation's and agent mode's Edit and Compose alike, asks `focusChanged`: the app in
>   front now against it (a read that fails counts as none). Changed: nothing is pasted; the text goes
>   on the clipboard and into the paste history, and the `copied` note ("Switched apps: copied to
>   clipboard and history") shows at the mouse pointer. Unchanged: the paste of ADR-DESK-002, into
>   whatever has focus in that app.
> - Canceled while the app in front is read: the text goes nowhere, not even the history.
> - Gone: `captureTarget`, `InsertionTarget`/`InsertionTargets`, the settle poll and its
>   `HelperConfig` values, the `insert` outcome and `session`, and the `caretMoved` outcome with its
>   "Cursor moved" note. `insert` is as before this ADR.
> - Consequences: a caret moved within the same app is not put back (the ADR-DESK-002 behavior);
>   a helper restart after key-down no longer copies the text once the restarted helper is up (it reads
>   the app in front as well); a read that fails while it restarts copies it. The decision below is kept as the record of what was tried.

**Context:** Owner, 2026-09-30: "if I move my cursor or caret while the dictation is still trying to
go on, I paste it in the wrong place … paste … where the dictation button was pressed". The paste
(ADR-DESK-002) went to whatever had focus when the text arrived. Asked, the owner chose, both for an
app switched in the meantime and for a caret that can't be put back: "Don't paste, keep text". Then:
"if the app focus changed, we can just briefly show at the mouse cursor location that we've just
copied it into your history and also your clipboard" (the history is ADR-DESK-043).

**Decision:**
- At key-down the controller asks `voice-macos` to keep the insertion target (`captureTarget
  {session}`, the dictation's generation): the app in front, its focused element
  (`kAXFocusedUIElementAttribute`) and that element's selection, as a text-marker range
  (`AXSelectedTextMarkerRange`, WebKit and Chromium) where it has one, else a character range
  (`kAXSelectedTextRangeAttribute`). One target is kept, the latest dictation's; each AX call times
  out after `HelperConfig.insertionTargetTimeout` (0.25 s).
- `insert {text, restoreDelay, session}` first puts the target back (`InsertionTarget.restore`):
  another app in front → `appChanged`; focus in another element → focus it back, and `caretMoved` if
  it won't take it; a caret moved → select the kept range again, and `caretMoved` if the field won't
  take it. A set gets `insertionTargetSettleTime` (0.2 s) to show, checked every
  `insertionTargetPollInterval`: Chromium hands focus and selection sets to its renderer and answers
  reads from its cached tree until the renderer replies. Only then the paste of ADR-DESK-002; the reply is `{outcome: "pasted" | "appChanged" |
  "caretMoved"}`. Nothing is ever brought to the front: an app switch is the user's. Captures run
  concurrently, so an older session's finishing late never replaces a newer one's; an `insert` whose
  session has no target (a capture that failed, a helper restarted since key-down) pastes nothing.
- Two marker ranges are the same when `CFEqual`, or when both have the same non-empty bounds
  (`AXBoundsForTextMarkerRange`, taller than zero): an app may describe one place with different
  marker objects.
- Not pasted: the text goes on the clipboard (Electron's `clipboard.writeText`, left there, not
  restored) and into the paste history, and the dictation ends in a `copied` phase whose message
  ("Switched apps: copied to clipboard and history", "Cursor moved: …") shows at the mouse pointer,
  where the user now is, not at the old caret, for `overlayErrorDisplayDuration`. Like `failed`, the
  next hold replaces it.
- Agent mode's Edit and Compose paste the same way; the target app check they had
  (`isTargetAppFrontmost`, the "You switched apps, so nothing was pasted" failure of ADR-DESK-011's
  amendment) is gone, the helper's check replacing it. The Thunderbird tool is unchanged.

**Consequences:**
- An app that shows no focused element at key-down (thin accessibility trees, some games and
  terminals) is checked by app only: the text pastes where focus is then, in that app.
- A field without a readable selection gets its focus back, not its caret.
- A caret the user moved on purpose within the same field goes back to where it was at key-down.
- A dictation whose `voice-macos` restarted after key-down (ADR-DESK-032's amendment: "what was said
  is then pasted through the restarted helper") is copied instead, with the "Cursor moved" note: the
  restarted helper has no target for it.
- The clipboard keeps the text after an unpasted dictation: the user's earlier clipboard is replaced,
  which is what "copied to your clipboard" means.

## ADR-DESK-043: The paste history, on a triple tap

**Context:** Owner, 2026-09-30: "triple tap to see past history of the pastes, so that you can
actually just click on one of those to copy", and "when dictation is going on … show the press space
to enter agent mode or triple tap to see history tooltip".

**Decision:**
- `PasteHistory` (`src/core/dictation/pasteHistory.ts`) keeps every text dictation and agent mode pasted, or
  copied instead (ADR-DESK-042), the newest first, at most `pasteHistoryLimit` (20); the same text
  again moves to the top. **In memory only**, for the app's life: no user content is written to disk
  (root ADR-004).
- Gesture (`PushToTalkGesture`): a press while hands-free that comes within `doubleTapWindow` of the
  double tap's second release is `showHistory`, not `finish`. The hands-free dictation the double tap
  started has heard a moment at most; it is discarded unseen.
- The history window (`history/index.html`) opens where the chat window's answer box does (amended, owner,
  2026-09-30: "paste history should appear like the answer tool, not near cursor";
  `historyWindowFrame`): `chatPillGap` over the pill of the hold that asked for it and its bubbles,
  or under them where there is more room (`chatSide`, with the history's tallest), centered on the
  pill and kept on screen, the edge by the pill staying put as the list measures itself. The pill's
  place (`OverlayWindowController.pillPlace`: at the caret, or the pointer without one) is read before
  the hands-free dictation is discarded, which forgets it. (It first opened by the mouse pointer,
  `historyWindowOrigin`, now gone.) It is `pasteHistoryWindowWidth` wide (the chat's width) and as
  tall as its list up to `pasteHistoryMaxHeight`; it opens hidden and shows, focused, once the list
  has measured itself (`Windows.fitHistory`; owner, 2026-09-30: "a brief flash where the pill renders
  at full height and shrinks"), a reopening keeping the last measured height. Each entry is clipped to `pasteHistoryEntryLines`
  lines with how long ago it came. It takes focus; a click copies the whole entry to the clipboard and
  closes it; Escape or a click elsewhere closes it. On macOS the app then hides, so focus returns to
  the app the user was in, unless Settings, the welcome window, the context debug window or the chat
  window is open (hiding the app would hide the chat, with nothing to show it again while the next
  holds talk to it).
- The Space tip becomes `agentAndHistoryTip` ("Press [space] for agent mode, / triple-tap [hotkey]
  for history", 4 s, at most 10 holds); opening the history learns it. Using Space no longer does,
  as the tip still teaches the history. Its new id restarts its counts.

**Consequences:**
- The history is lost when the app quits.
- A triple tap works only from hands-free listening: while the previous dictation is still
  transcribing, the double tap finds nothing listening and the gesture ends, so a third press starts
  a new hold. With the history open, a paste still to come sees this app in front and is copied.

## ADR-DESK-044: The code in folders by concern, each with a place for what comes next

**Context:** Owner, 2026-09-30: the agent's tools sat in `src/core/agent/` beside the agent, its
chat and the connectors, with nothing to say which file is a tool, and `native/macos/Sources/` mixed
the lowercase executables (`voice-hotkey`, `voice-macos`) with the libraries, `VoiceMacOSKit` one
flat folder of everything the helper does. The owner asked for a layout where it is plain where a
tool goes, as in the iOS app (`Services/AI/Tools/`), Thunderbird (`chat/tools/`) and the backend
(`src/tools/<platform>/`), that scales as tools, connectors, platforms and windows are added, and
that Thunderbird counts as a connector; a reorganization only, with no change to what the code does.

**Decision:**
- No file repeats its folder's name (owner, 2026-09-30: "no repeated folder names in the sub names"):
  the folder says what it holds, the file what part it is (`agent/chat.ts`, not
  `agent/agentChat.ts`), and an entry point is `index` (`main/index.ts`, `preload/index.ts`, each
  window's `index.html`). Swift keeps its own convention, a file named for the type it declares.
- `src/core/agent/`: the agent's requests to the backend (`requests.ts`, `DesktopAgent`), the chat
  window's conversation (`chat.ts`), the bubbles' order (`bubbleOrder.ts`) and agent mode's own
  tools, Edit, Compose, Thunderbird and Answer (`tools.ts`); then `connectors/`, the apps Answer's
  model reaches on this computer: one file per connector with its tools (`calendar.ts` … `web.ts`;
  **a new tool goes in its connector's file, a new connector is a new file**), the contract both
  keep (`contract.ts`), the generated list of them (`registry.ts`) and what the rest of the app reads
  (`index.ts`), the AppleScript runner Notes and Messages go through (`appleScript.ts`) and
  `thunderbird/`, the relay to TabMail's chat (`relay.ts`) and the
  email app it drives, where its native connector will go (ADR-DESK-037). A connector that needs
  more than a file gets a folder, as Thunderbird has.
- The rest of `src/core/` by concern: `dictation/` (the controller, the cleanup, the screen read,
  the paste history), `audio/` (the recorder, levels, WAV and FLAC), `backend/` (sign-in, the
  completions and transcription clients, their errors, HTTP), `dictionary/`, `hotkey/`,
  `onboarding/` (the wizard, permissions, tips, the VS Code fix), `ui/` (the overlay's geometry, the
  tray menu's model) and `util/`; `config.ts`, `log.ts` and `settings.ts` stay at its top, as every
  part reads them.
- `src/main/`: `index.ts` wires the app; `native/` is the app's side of the OS helpers
  (`helperClient.ts`, `macos.ts`, `osascript.ts`); **Windows' and Linux's go beside them.**
  `storage/` holds what the app keeps: the sign-in, the preferences file, the debug log and
  Thunderbird's profiles read. The windows, the tray, the microphone, the updater and the
  permissions stay at its top.
- `src/renderer/`: each window is a folder, `<page>/index.html` (what Vite builds and the window
  loads, `dist/renderer/<page>/index.html`), `index.tsx` and `index.css`, with anything else only it
  uses; what the pages share is in `shared/`. **A new window is one folder.**
- `native/macos/Sources/`: each helper is an executable target named as the libraries are
  (`VoiceHotkey`, `VoiceMacOS`: only its `main.swift`) over its library (`VoiceHotkeyKit`,
  `VoiceMacOSKit`), beside `VoiceHelperSupport`, the line protocol both use. The products keep the
  executables' names, `voice-hotkey` and `voice-macos`, which the app spawns and ships.
  `VoiceMacOSKit` has `MacService` (the requests) and `HelperConfig` at its top and the rest in
  folders by concern, mirrored in its tests: `Dictation/` (paste, microphone, caret, focused field,
  keyboard language, the screen read), `System/` (Accessibility activator, apps, Globe key) and
  `Connectors/` (Calendar and Reminders, Contacts, Files: what the TypeScript connectors reach).
- `test/` mirrors `src/`: a module's test has its name and folder under `test/` (the renderer's
  `<page>/index.test.ts`), a test file tests one module, shared stubs and the fake helper are in
  `test/support/`, and the package's checks (`packaging.test.ts`) are at the top.
- Names follow the TypeScript conventions (owner, 2026-09-30: "make things more standard"), renamed
  with the language service so only real references changed:
  - Error classes end in `Error`, as JavaScript's own do: `AgentFailure` → `AgentError`, likewise
    `ContactStore…`, `EventStore…`, `FileStore…`, `Helper…`, `Microphone…`, `NoEmailApp…`,
    `Relay…`, `Script…` and `WebRead…` (their `…Kind` types too), `NotPasted` → `NotPastedError`,
    `LoopToolArgumentError` → `ToolArgumentError`. The kinds, the helper's wire codes, are unchanged.
  - An acronym is written in capitals, as the code already had it (`HTTPRequest`, `JSONFileStore`,
    `bundleID`, `mailtoURL`): `userId` → `userID`, and the SVG hook `useSvgId` → `useGradientID`.
  - A list of names is `…ID`, the object it names takes the plain noun: `AgentTool` (the names:
    edit, compose, thunderbird, answer) → `AgentToolID`, `agentTools` → `agentToolIDs`,
    `offeredAgentTools` → `offeredAgentToolIDs`, `isAgentTool` → `isAgentToolID`; the tool itself,
    `DesktopTool` → `AgentTool`, and `toolImplementations` → `agentTools`. `Connector` →
    `ConnectorID`, `connectors` → `connectorIDs`, `isConnector` → `isConnectorID`.
  - `LoopTool` → `ConnectorTool` (`connectors/contract.ts`): a tool a connector brings, not the
    backend's loop it runs in; `loopTools` → `connectorTools`, `config.loopToolDeclined` and
    `loopToolUnanswered` → `connectorToolDeclined` and `connectorToolUnanswered`.
  - The main process's preferences file, `FileStore` → `JSONFileStore` (`storage/jsonFileStore.ts`),
    as the Files tools' `FileStore` is the Spotlight one.
  - `config.ts` keeps its rule, durations in milliseconds unless the name says otherwise; the four that
    were seconds without saying so say it: `pillSpringResponseSeconds`,
    `agentBubbleRunningSpringResponseSeconds`, `agentBubbleMoveDurationSeconds`,
    `chatAppearDurationSeconds`; the two milliseconds that said so drop the suffix
    (`webReadTimeoutMs` → `webReadTimeout`, `webReadRobotsTimeoutMs` → `webReadRobotsTimeout`).
- The connectors' list is generated, as the backend's tool registries are (owner, 2026-09-30:
  "someone doesn't have to remember to update both registry and tool file"). Each connector is
  declared once, in its own file: `export const webConnector = defineConnector({ id, order,
  displayName, settingsDescription, serverTools?, tools(services) })`. `scripts/gen-registries.mts`
  (`npm run gen:registries`, run before every build, typecheck and test run) writes `registry.ts`, marked
  AUTO-GENERATED, with the `ConnectorID` union and the connectors in their `order`. `index.ts`
  derives `connectorIDs`, `isConnectorID` and `connectorByID`, replacing the hand-kept
  `connectorInfo` and `connectorServerTools`. The main process builds every tool from the list over
  one `ConnectorServices`, the OS access (Calendar and Reminders, Contacts, Files, the email app,
  osascript, the web). The order keeps the switches and bubbles where they were. A test fails when
  `registry.ts` is behind the files, and the generator refuses a declaration it can't read and an id
  or order used twice. Only the icons stay beside the pages (`icons.tsx`, a `Record<ConnectorID>`, so
  a connector without one doesn't compile).
- American spelling throughout (owner, 2026-09-30: "consistent american spelling"), in names, CSS
  classes, UI text, comments and docs, as the platforms' own APIs have it (`color`, `center`):
  `brandColour` → `brandColor`, `hintCentre` → `hintCenter`, `grey` → `gray`, `honoursCancel` →
  `honorsCancel`, the `centred` class → `centered`, "Cancelled." → "Canceled.", and likewise
  behavior, neighbor, favor, -ize, labeled, signaled, modeled. Only URLs keep their spelling.
- Beyond the moves, only import paths, the pages' script and entry paths, `Package.swift`'s target
  names, the paths tests read from disk and the names above changed; the backend clients' module
  was split in three (`completions.ts`, `transcription.ts`, `errors.ts`, the request log and headers
  joining `http.ts`), and tests that covered several modules were split to one file each.

**Consequences:**
- A branch open before this change rebases with git's rename detection; a file it adds under an old
  folder moves by hand, and its imports follow.
- Verified against `main` at 0.1.2: the same suites pass in the same numbers, the build gives the
  same pages and helpers, and `npm run preview` renders every window as before (the frames that
  differ are the animated ones, which differ between two renders of `main` too).

## ADR-DESK-045: Apps the screen is never read in, with the password managers built in

**Context:** Screen reading (ADR-DESK-008, ADR-DESK-010) was on for every app or off for all. A
password manager shows revealed passwords, one-time codes and notes as plain text, and its window
was read like any other. Owner, 2026-09-30: the password apps should be excluded from the capture,
with a Privacy section in Settings for the excluded apps: built-in exclusions, and additional apps
the user adds (issue #5).

**Decision:** An excluded app is never read. The list is the built-in password managers
(`config.builtInExcludedApps`: Passwords, Keychain Access, 1Password 8 and 7, Bitwarden, KeePassXC,
NordPass), excluded in every installation and not removable, plus the apps the user adds
(`AppSettings.excludedApps`, kept on this computer; `ExcludedApp` in `dictation/excludedApps.ts`).
Apps are known by bundle identifier, compared without regard to case.

- The dictation's key-down snapshot (ADR-DESK-017) carries the identifiers
  (`DictationSettings.excludedApps`). They go with the screen read (`readScreen`) and with every
  read of the pasted-into field for correction learning (`focusedFieldValue`, ADR-DESK-038).
- `voice-macos` refuses: `readScreen` finds the app in front and, if it is excluded, answers that it is hidden
  without reading it, the same lookup deciding both; `focusedFieldValue` answers no value for an
  excluded app's process. A request that doesn't carry the list is an error, so nothing is read by
  mistake. `ScreenAccess` is what those two requests read through, or a test's stand-ins.
- With no screen read, a dictation in an excluded app is as one with screen reading off: pasted,
  cleaned up without the screen, no screen terms in the vocabulary, no selection for agent mode's
  Edit, nothing kept for the debug window or the debug log, no correction learned.
- Agent mode is told the screen is hidden (owner, 2026-10-01). A screen that is not read for
  privacy (an excluded app, a page of an excluded website or of an unknown address: ADR-DESK-047)
  is answered by the helper as `{hidden: true}`, with nothing of the screen, not as null, which
  stays the answer for no app in front and for a read that failed. The app keeps treating it as
  no screen everywhere (`screenShown`), and agent mode's tools get `screenHiddenNote` as the
  screen's text (`screenVariables`), with the app, host, window title and selection empty. Without
  it a question asked in the kept-open chat after moving to an excluded page was answered from the
  earlier page, since an empty screen and a hidden one looked the same to the model. The note says
  only that the screen is hidden, not which app or site: naming it would send what the user chose
  to keep out. The dictation cleanup and the agent's choice of tool get no note (the first needs
  none, the second has no screen text). The note is the app's text in an existing prompt variable,
  so the backend prompts are unchanged. A helper that still answers null there is as before: no
  screen, and no note.
- Settings › Privacy (macOS, where the screen is read): the built-in ones named in a note, the user's
  apps with a Remove button each, and Add App…, which opens a picker on the Applications folder; the
  helper's `appInfo` gives the picked app's identifier and name.
- What is excluded is what is saved (owner, 2026-10-01): an exclusion or a removal that could not be
  written to the preferences file did not happen. The list is put back as it was
  (`AppSettings.saveExclusions`), `excludeApp` and `excludeSite` answer `unsaved`, and Settings says
  why. Nothing is excluded only until the app quits. *(This replaces the same day's first form, in
  which an unsaved exclusion was held for the run and saved by adding it again.)* Other settings
  still fail to save silently, logged only.
- The lists are bounded only so they can't grow without end (owner, 2026-10-01): at
  `exclusionsMax` (1,000) apps, or websites, one more is refused with the reason. Nothing is
  disabled or noted before that, and a stored list is read back whole. *(Was 100, with Add App…
  disabled and a note when full.)*

**Consequences:**
- A deny-list: every other app is read as before. Websites are excluded one by one since ADR-DESK-047
  (#77).
- A password manager not in the built-in list is read until the user adds it. Only identifiers
  checked against the app itself or its Homebrew cask are built in.
- An app without a bundle identifier (a bare process) can't be excluded.
- A secret shown in an app that isn't excluded (a key in a terminal) is still read; redacting
  secret-looking text is a follow-up (#78). Password fields are skipped in every app (ADR-DESK-007,
  amended 2026-09-30).
- "Read the screen while dictating" stays under Dictation and "Learn from my corrections" under
  Dictionary.
- The check is in the helper, not the Electron app (owner, 2026-10-01): the helper is small and
  ours, so an excluded app's text never reaches the app's main process. Every platform's helper
  takes the same list and refuses the same way.
- The Thunderbird relay's `focusedElement` (the email app's focused role and window title) is not
  gated by the list: it reads only the email app, and its tool is off (ADR-DESK-037).
- Windows and Linux get the list with their helpers' screen read.

## ADR-DESK-046: Secret-looking text is taken out of the screen read, in the helper, from one shared definition

**Context:** The screen read skips password fields (ADR-DESK-007, amended 2026-09-30) and excluded
apps (ADR-DESK-045), but a secret shown as plain text is read like any other text and sent with the
dictation: an API key printed in a terminal, a token on a dashboard, a private key open in an
editor. Owner, 2026-09-30 and 10-01: the context should not capture secrets; simple heuristics are
good enough (#78); it belongs in the helper, which is small and ours, so that a secret never reaches
the Electron process; and the three platforms' helpers must share the same logic, with a
well-structured place for the redactors.

**Decision:**
- What looks like a secret is defined once, in `native/shared/privacy/redactors.json`: an ordered
  list of redactors, each a name, a regex, a case flag and a replacement. They cover private-key
  blocks (whole, or cut off where the window ends), JSON web tokens, `Bearer` tokens, the password in
  an address (`scheme://user:password@host`, with a user name or not; the password runs to the last `@` before the path, since a password may hold one), a value given to a name like `password`, `token`,
  `secret` or `api_key` (when it has a digit and at least 6 characters), and keys with a provider's
  prefix (`sk-`, `sk_live_`, `whsec_`, `ghp_`, `github_pat_`, `glpat-`, `AKIA`, `AIza`, `xoxb-`,
  `npm_`, `hf_`). A match becomes `[redacted]`; the name, the word `Bearer` and the rest of an
  address stay, so the text still reads.
- Each helper's list is generated from that file (`scripts/gen-redactors.mts`,
  `npm run gen:redactors`, run with the registries before every build, typecheck and test), as the
  connectors' registry is (ADR-DESK-044): macOS gets `Privacy/Redactors.generated.swift`, and a
  platform's helper adds its emitter there. No helper copies a pattern by hand. The generator
  refuses regex syntax ICU, ECMAScript and PCRE don't read alike (lookbehind, named groups, Unicode
  classes, inline flags, possessive and atomic groups, backreferences, and `\b`, `\w` and `\d`), and
  a replacement naming a group its pattern lacks.
- No pattern uses a word boundary. ICU counts every script's letters as word characters and
  ECMAScript only ASCII's, so a key written straight after a Japanese, Korean or accented word was
  kept by the Mac helper and redacted by the same pattern in JavaScript. Where a key must not start
  inside a word, the pattern takes the character before it (`(^|[^A-Za-z0-9_])`) and the replacement
  puts it back; where it must not run on, a lookahead says so.
- Every pattern takes time in proportion to the text. Screen text has no length limit, may be
  anyone's (a web page, a message), and is redacted with no deadline, so a repeat scanned again from
  every position is refused in review: it is bounded, or the pattern begins where a run begins (a
  key block's kind, before and after `PRIVATE KEY`, is at most 40 characters). Both suites time
  each pattern on hostile text.
- No run stops a redactor short. ICU runs an open-ended count (`{16,}`) and a repeated `\s` outside
  a class with a stack frame per repetition, and on a run of some 200,000 characters gave up,
  silently matching nothing after it: every later secret of that read was sent. The patterns use
  the forms it runs as one loop (`[..]{16}[..]*`, `[\s]*`), the generator refuses the others, and
  `Redactor.redact` asks the engine whether it finished: a redactor that did not withholds
  everything after its last match (`[redacted]` in its place).
- `native/shared/privacy/redaction-cases.json` is what every helper must do with them: each case's
  text and what it becomes. Every helper runs the cases in its own suite, on its own regex engine;
  that is what shows the helpers agree. The texts are split into fragments, so the file holds
  nothing shaped like a real key.
- `voice-macos` redacts every text of the screen read as it replies (`ScreenContext.json`, the one
  way a read leaves the helper; `ScreenContext.redacted`): the window's title, the visible blocks,
  and the text before, in and after the selection. The rendered text and the log description are
  built from the redacted blocks. The focused field's value for correction learning is redacted too.
- The texts of a read are redacted together, not one by one (`Redactor.redact` of several lines):
  as the one text they make, a line break between the blocks, and nothing between the three texts
  around the caret. A secret spread over several elements (a key's lines, one each; `Bearer` and its
  token) or one the caret or the selection is inside only shows once they are joined. Each text then
  keeps its share of the result: what replaces a secret goes to the text the secret began in, what
  the replacement keeps of the match's start and end stays where it was, and a text wholly inside a
  secret comes back empty (such a block is dropped; a selection left empty or blank becomes
  `[redacted]`, so it is still a selection, and Edit refuses it). The blocks are redacted before they are rendered, because the marks the rendering
  puts before a field's, a row's and the focused field's lines would break a key of several lines.
  The rule is the helpers' to share like the patterns: its cases are `lineCases` in
  `redaction-cases.json`, which every helper's suite runs.
- The reply says when the selection had a secret taken out (`selectionRedacted`). Agent mode's Edit
  then refuses (`AgentError.secretInSelection`), asking the backend nothing: its rewrite of the
  redacted selection, pasted over the real one, would put `[redacted]` where the secret was. The
  other tools still get the redacted selection. The helper's screen-privacy code lives in
  `Sources/VoiceMacOSKit/Privacy/`.
- Always on; not a setting, like the password-field skip.

**Consequences:**
- A safety net, not a guarantee: a secret in a shape the patterns don't know (a bare random string, a
  password with no name beside it) is still read. Long random strings are not matched by entropy,
  which would also take out hashes and identifiers.
- A password without a digit after a name (`Password: correcthorse`) stays, so that a form's
  `Password: required` does.
- A secret cut by the edge of what is read (the focused field's text is read 2,000 characters each
  side of the caret; a terminal's from its first visible line) is only found when the part read
  still has its shape: a private key's header and what follows are, its last lines alone are not.
- A selection holding a secret can't be rewritten by voice (Edit refuses, saying why); a plain
  dictation over it replaces it as always.
- Texts that sit side by side on screen are still joined by a line break here, so a name and its
  value in two elements are found together, and so are two elements that only look like one (a
  label ending in `token:` above an unrelated word with a digit).
- A private key written on one line with its line breaks escaped (`\n` as two characters, as a JSON
  file or a quoted value holds it) is taken whole: the key's body may hold a backslash. One with
  header lines after its first (an encrypted PEM key, a PGP key with a `Version:` line) keeps its
  body, whatever name is beside it; a key header with nothing
  after it takes the letters that follow, up to the first punctuation. The key block's redactor is
  the last in the list for that reason: first, it took a later secret's name or prefix with those
  letters, and that secret's own redactor no longer knew it.
- What a replacement keeps of its match is told by comparing the two texts. A secret that itself
  ends in `]`, with a boundary between two texts just before that `]`, leaves the placeholder's
  last character in the second text. Nothing of the secret is kept.
- Edit's refusal asks the backend for no rewrite. When several tools are offered, the pick of the
  tool has already been asked, with the redacted screen.
- A correction of a word into something secret-looking is not learned: the field is redacted before
  the core compares it. When the heard word is close to the placeholder's own (`rejected`), the
  word `redacted` is learned in its place.
- A table row is one text, its cells joined by ` | `: a name in one cell and its value in the next
  stay, as a label with no `=` or `:` above its value does.
- The Windows and Linux helpers redact once they add their emitter and run the shared cases.

## ADR-DESK-047: Websites the screen is never read on, with the password managers' web vaults built in

**Context:** An excluded app (ADR-DESK-045) is the whole app. A bank or a password manager's web
vault open in a browser was read unless the whole browser was excluded. Owner, 2026-09-30 and
10-01: websites can be treated as an app is, excluded one by one (#77), and the check stays in the
helper, the same in every platform's helper.

**Decision:** An excluded website is never read. The list is the built-in web vaults
(`config.builtInExcludedSites`: 1Password's, Bitwarden's, Google Password Manager's, LastPass's,
Dashlane's and Proton Pass's), excluded in every installation and not removable, plus the sites the
user adds (`AppSettings.excludedSites`, kept on this computer). A site is known by its host
(`example.com`), which covers its subdomains (`mail.example.com`) and no host that only ends or
starts alike; case and a trailing dot don't matter.

- The key-down snapshot (ADR-DESK-017) carries the hosts (`DictationSettings.excludedSites`) beside
  the apps, as one `ScreenExclusions`. Both go with the screen read and with every read of the
  pasted-into field: `readScreen` and `focusedFieldValue` take `excludedAppIDs` (renamed from
  `excludedBundleIdentifiers`, so that every platform's helper uses one name) and `excludedHosts`.
- `voice-macos` refuses (`Privacy/ScreenExclusions.swift`, which holds both matches and the
  fail-closed reading of the two lists). The page the caret is in is checked first, before the
  caret's text or the window's title is asked for (`ScreenContextReader.gather`): every web area
  above the focused element, and the focused element itself, since a page clicked on or selected in
  has the focus itself, and any page inside the focused element (a page that frames an excluded
  one, a focused group holding one: `holdsExcludedPage`), which the walk never goes into. The walk then refuses the whole window at any page of an excluded site, in
  focus or not, framed in another page or inside a row, a heading or a link that has no label of its
  own (one with a label gives its label, and nothing inside it is looked at): with the caret in the
  browser's address field the page is still on screen. `readScreen` answers that the screen is hidden, as for an excluded
  app, and drops a context whose host is excluded whatever the reader did. A refused read gives
  back nothing of what it had gathered (`gather` answers no context at all). `focusedFieldValue`
  answers no value for a field whose window shows a page of an excluded site: the field's own
  pages, what the field holds, and the rest of its window, so the address field of a browser showing
  an excluded page is not read either (owner, 2026-10-01). A request without either list is an
  error.
- Read only what can be told safe (owner, 2026-10-01): a page whose address the app fails to give
  (the lookup timed out, the app gone) is treated as excluded, wherever it is (`PageHost.unknown`).
  Only the app's answer that the page has no address makes it a page with no host, which is read.
- Which host a site covers is one rule for the app and every helper:
  `native/shared/privacy/host-exclusion-cases.json`, which the app's `coversHost` and each helper's
  match are tested against, as the redactors' cases are (ADR-DESK-046).
- Settings › Privacy: a field takes a site by its address (`https://mail.example.com/inbox` is kept
  as `mail.example.com`: `excludedSite` drops the scheme, sign-in, port and path), the user's sites
  with a Remove button each, and the built-in ones named in a note. At most `exclusionsMax`, as for
  apps (ADR-DESK-045).
  A site that could not be saved, or a removal that could not, did not happen and is said so, as
  for an app (ADR-DESK-045).

**Consequences:**
- A window showing an excluded site gives no screen context at all, not the rest of the window
  either: a dictation there is as one in an excluded app.
- The host is the page's as the browser reports it through Accessibility (a web area's URL). A
  browser that doesn't report one, or a site inside an app that hides its pages' addresses, is read.
  A page in a background tab is not on screen and doesn't count.
- A page that frames an excluded site (a payment form from an excluded host) is not read either.
- A window with a page whose address lookup fails gives no screen context for that dictation, and
  ends the watch for corrections, whatever the page is.
- A walk that runs out of its node or time budget before reaching a page out of focus never saw
  that page: what it gathered before, and the window's title, are kept. The page's own text is not
  among it. The look inside the focused element keeps to the same budgets. Kept as it is (owner,
  2026-10-01): failing closed would drop the context of every large window.
- Before a field is read for corrections its window is looked through for pages, every half second
  while the watch runs, so for at most `focusedFieldPageScanBudget` (0.2 s) and without going into a
  page that is not excluded: a page framed in another one beside the field, or one not reached in
  that time, does not stop the read. The field's text stays on this computer.
- Only `http` and `https` pages have a host; an extension's page (a password manager's browser
  extension) can't be excluded by host, and its password fields are skipped as everywhere.
- Hosts are ASCII: a site with an internationalized name is added in its `xn--` form.
- The built-in hosts are the vaults' addresses as known when this was written; one that moves is
  read until the list is updated or the user adds it.
- Windows and Linux take the same two lists with their helpers' screen read, and run the shared
  host cases.
