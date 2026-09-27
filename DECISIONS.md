# TabMail Voice — Decisions

Compact index of architectural decisions for `tabmail-voice` (the TabMail Voice app). Cross-cutting decisions live in the
root `DECISIONS.md` (notably ADR-004 zero content retention, which dictation audio and transcripts
fall under).

---

## ADR-DESK-001: Native Swift menu-bar app, on-device speech recognition

> ⛔ **Speech-recognition half SUPERSEDED by ADR-DESK-005 (owner 2026-09-24).** The native Swift menu-bar app stands; on-device `SpeechAnalyzer` was removed in favour of backend STT so all platforms share one engine. Kept for history.

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
apps; synthesising per-character key events is slow and breaks on non-ASCII text. Pasting is what
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

**Consequences:** Adding backend features later requires the backend to recognise a `desktop`
client type.

## ADR-DESK-005: Speech-to-text on the TabMail backend (OpenRouter), shared by all platforms

**Context:** Owner, 2026-09-24: dictation should use an OpenRouter speech-to-text model via our
backend, so the same engine serves desktop, iOS and Thunderbird later.

**Decision:** The app records 16 kHz mono 16-bit PCM (`AudioRecorder`), wraps it in WAV
(`WAVEncoder`) and posts it as base64 JSON to the TabMail backend's `POST /dictation/transcribe`,
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
- Recording auto-stops at `maxRecordingDuration` (5 min ≈ 9.6 MB, under the backend's 10 MiB upload limit).
- A failed transcription loses that recording (no retry queue yet). Chunking long dictations
  (transcribe ~20–30 s pieces as they complete, retry a failed piece alone) is tracked in
  issue #1 (P3).
- macOS 15+ (the macOS 26 floor existed only for `SpeechAnalyzer`).

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
The overlay uses only the icon's blue → purple. The pill is
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
  the request is cancelled and the transcript is pasted as heard, like any other failed cleanup.
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
- **Steps.** Consent → Permissions (Microphone, Accessibility) → Features (screen reading).
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
  desktop tool listed there would reach Thunderbird's agent too. The later Thunderbird connector
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
  disappears after a little"): a tooltip centred under the pill, with an arrow up at it, always
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
  day, owner: "appear on top … like a list on top": one row centred above the pill; the hint then
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
Thunderbird installer's pkg (`tabmail-release-helpers/tb-mac/build-mac-installer-local.sh`) installs
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
  recogniser, dictation and agent flow, backend clients, WAV encoding), they move into
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
- The chat is recognised by its exact title, "TabMail Chat". On macOS Thunderbird titles an add-on's
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
  the chat as Thunderbird's focused window), and a cancel is honoured before the paste and before
  Return. When that first read finds no chat, Thunderbird is checked to be in front again, and a
  cancel honoured, before the shortcut: a false read can mean the user switched away, and ⌥⌘L
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
  hold in progress (`HotkeyMonitor.setHotkey`); the owner accepts that behaviour (2026-09-26).

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
  implementation, a `DesktopTool`. The protocol gives a tool its display name, symbol, backend prompt,
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
  generalise, and the next one decides its shape.
- The bubble's app icon still comes from `tool == .thunderbird` in `OverlayPanel` (left alone while
  another branch changes that file); a second app-backed tool moves it into the protocol.
- No behaviour change: the suite passes unchanged except `fitted(_:toSelection:)` moving from
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
  teaches, or has seen it `switchModeTipMaxDisplays` (10) / `doubleTapTipMaxDisplays` (5) times,
  then never again; the counts and the learned flags are kept in UserDefaults (`tip.<name>.displays`,
  `tip.<name>.learned`; no user content). Switching the mode learns the Space tip; a double tap
  learns the double-tap tip. The TipKit framework itself is not used: the overlay is a click-through,
  non-activating panel, so TipKit's views (dismissed by a click) do not fit, and its rules and
  datastore are global state a unit test cannot own.
- The controller decides which tip shows (`DictationController.tip`); the overlay draws it in the
  same dark tooltip under the pill (`TipTooltip`, formerly `ModeHint`) and shows none over the warm-up
  swirl. The Space tip is due as the pill starts listening; the double-tap tip once a hold has gone on
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
- Hands-free listening is capped like a hold (`maxRecordingDuration`, 5 min), then transcribed.
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
- A tip is three centred lines at 13 pt ("Press [space] to switch / between dictation / and agent
  mode"; "Double-tap [key] / to dictate / without holding"), each `tipLineHeight` tall, so its height
  is a config constant (`tipHeight`) and `opensUpward` still counts it exactly. The overlay canvas grew
  to 210 pt tall so the tip and its shadow fit under the vertically centred pill; on the screen's
  bottom lines the overlay is raised that much further above the caret.
- The double-tap tip did not show in the owner's test because it was already learned (a double tap
  came first), and the Space tip had used its 10 displays: working as decided, not a defect.
