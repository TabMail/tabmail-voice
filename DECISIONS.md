# TabMail Voice — Decisions

Compact index of architectural decisions for `tabmail-macos` (the TabMail Voice app). Cross-cutting decisions live in the
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
  for the cleanup. Still never logged or stored.
- A plain terminal tab without tmux gets its visible lines but no caret mark or program.
- The tmux pane is the most recently active client's, and is used only when most of its last
  lines appear in the front terminal's text; a tmux attached in another tab or window is ignored.
- OCR stays a possible later fallback for apps whose tree is thin, as an owner decision.

## ADR-DESK-008: Clean up every transcript with the screen context, on the backend

**Context:** Owner, 2026-09-25: after transcription, a language-model pass should fix dictation
errors using what is on screen, with the smallest possible changes. The instructions and the
model choice live on the backend, so they can be edited and switched there without an app release.

**Decision:** The screen context (ADR-DESK-007) is captured at key-down in every build. When the
transcript arrives, the app waits up to `contextWait` (0.5 s) for that capture and sends the transcript with the app name,
web host, terminal program, window title and the visible text (caret marked) to the backend's
`POST /completions/chat` as the prompt `system_prompt_dictate_cleanup`, then pastes the reply.
Request shape and server-sent-events parsing follow iOS `BackendClient`, with two deliberate
differences: the app fails the cleanup on an `event: error` (iOS logs it and waits for `final`),
and it accepts only HTTP 200 (iOS accepts any 2xx). The backend never sends both `error` and
`final`, and answers 200, so neither changes an outcome today.

**Consequences:**
- What is on screen while dictating is sent to the TabMail backend with each dictation; like every
  TabMail AI request it is not retained (root ADR-004), and the app logs sizes only.
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
  discloses it. `ScreenContextProbe` checks it at every key-down, so a change applies from the
  next dictation. It can also be switched in Settings.
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

**Context:** Owner, 2026-09-25: a double tap of the hotkey enters agent mode. Speech is then a
request to carry out, not text to insert. The first tools are **Edit** (rewrite the selected text
as asked, like Thunderbird's inline editor) and **Compose** (write new text at the caret, for any
app, not only mail). Their bubbles show beside the pill; after the request, the chosen tool's
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
  follows the same tool-choice contract (a third tool name), planned in `PLAN_DESKTOP_AGENT.md`.
- Apps whose accessibility tree hides the selection (thin trees, some Electron apps) can't be
  edited; the request fails with "Select the text to edit". Copying the selection with ⌘C
  instead would be a fallback: an owner decision.
- With screen reading switched off (ADR-DESK-010), there's no selection, so Edit never runs.
  Whether Edit reads the selection anyway is an owner decision.
- The selected text and the screen are sent to the backend with the request; nothing is stored
  (root ADR-004). The prompts treat both as content, never as instructions.

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
TabMail") still says "TabMail". The repository stays `tabmail-macos`.

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
  steps, after the open branches merge.

## ADR-DESK-014: Thunderbird connector spike: drive TabMail's chat from outside

**Context:** Owner, 2026-09-25: agent mode's bubbles become the supported apps, starting with
Thunderbird; any mail or calendar request goes to TabMail's chat in Thunderbird. Nothing outside
Thunderbird can reach the add-on today (no external messaging, no URL scheme, native messaging is
request/response). The owner chose a spike with no Thunderbird change before building a bridge,
the agent restating the request as a chat message, and sending being enough (no reply back).

**Decision:**
- A third tool, `thunderbird` (backend `system_prompt_desktop_thunderbird`, ADR-023), offered, and
  shown as a bubble with Thunderbird's own icon, only when Thunderbird is installed. The agent's
  prompt always names it; the app fails a request given to a tool it did not offer ("Mail and
  calendar requests need Thunderbird with TabMail").
- `ThunderbirdRelay` sends the chat message: launch Thunderbird if it isn't running (then wait for a
  window and `thunderbirdAddonSettle` for the add-on), bring it to the front through Accessibility
  (`AXFrontmost`: the app is never active, so cooperative activation would ignore
  `NSRunningApplication.activate`), post the add-on's ⌥⌘L unless the focused window is already
  the chat, wait for a window titled "TabMail Chat", paste, press Return.
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
