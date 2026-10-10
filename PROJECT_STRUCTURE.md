# TabMail Voice — Project Structure

Menu-bar dictation app: hold a key, speak, and the text is typed into whatever field has focus.
Speech is transcribed by the TabMail backend (`POST /dictation/transcribe` → OpenRouter). One
Electron app for macOS, Windows and Linux (ADR-DESK-032), macOS 15+ first; the dictation path
(microphone, hotkey, paste) runs in native helpers per platform (macOS today; Windows and Linux to come). The Swift app it replaced was
removed at cutover; its last source is in git history.

```
tabmail-voice/
├── Scripts/stt-compare/      Speech-to-text model comparison (platform-free; see README)
└── apps/                     The app's folder (ADR-DESK-013, amended by ADR-DESK-032)
    └── desktop/              The Electron app, below
```

## `apps/desktop/`: the Electron app (ADR-DESK-032)

The app for macOS, Windows and Linux. TypeScript,
Electron 44, React 19, Vite, Vitest, electron-builder; npm (`npx -y npm@11.19.1 install`).

```
apps/desktop/
├── package.json, electron-builder.json, tsconfig.{base,main,renderer,test}.json, vite.config.mts, vitest.config.mts, eslint.config.mjs
├── resources/               App icon, tray template images (plain, and marked with a dot while a permission is missing), DMG window background (1x, 2x), macOS entitlements (electron-builder's buildResources); linux/install-update and linux/update-keys/ (ADR-DESK-050)
├── scripts/
│   ├── build-native.mts         Shared dispatcher; macos/build-native.mts (SwiftPM) and windows/build-native.mts (CMake/MSVC) copy helpers into dist/helpers
│   ├── gen-registries.mts       Writes src/core/agent/connectors/registry.ts from each connector's `defineConnector` (run before build, typecheck and test)
│   ├── swift-errors.sh          Runs a SwiftPM command in native/macos, printing only diagnostics and summaries; `test` runs the shared Rust core's `cargo test` first
│   └── preview/                 `npm run preview`: renders the overlay, Settings and welcome windows with sample states offscreen, saved as PNGs; exits 1 when a shot fails its checks (a page error, something cut off, the not-pasted note's layout as Chromium lays it out)
├── native/shared/rust/      Shared static library, the ONE home of logic the helpers share (ADR-DESK-054; native code is thin OS adapters): redaction, context normalization/rendering, exclusion/address policy, terminal viewport (and the box around its cursor, `terminal_box`), gesture transitions and the microphone's sessions; Swift/C++ C ABI adapters; locked toolchain and conformance tests
├── native/shared/context/   Screen context types and cross-platform context fixtures; `screen-cases.json` (the screen read's whole reply, built by the Rust `screen` op) `request-cases.json` (a field read's bound and reply and a paste's text and deadline, the Rust `request` op) `surface-cases.json` (a terminal surface's runs, selection and caret, the Rust `viewport` op's `surface` request; macOS and Linux) and `walk-cases.json` (the screen walk's steps, the Rust `walk` op; `walk.h` is its C++ wrapper, Swift `SharedWalk`), run by Rust and the helpers (`windows/tests/screen-reply.cpp` and `core-cases.cpp`, built on Linux too; Swift `RedactorTests`): ADR-DESK-054
├── native/shared/microphone/ `voice-microphone`'s shared parts on every platform: `session-cases.json` (which session runs and when the process ends, the Rust `microphone` state; `sessions.h` is its C++ wrapper, Swift `MicrophoneSessions`), run by Rust, Swift and `session-test.cpp` (Windows, Linux); `protocol.mjs`, the Windows and Linux helpers' wire checks: ADR-DESK-032
├── native/shared/privacy/   What every platform's helper shares: `redactors.json` (what looks like a secret in text read off the screen) and `redaction-cases.json` (what each helper must do with it): ADR-DESK-046; `host-exclusion-cases.json` (host matching) and `address-cases.json` (shared URL classification): ADR-DESK-047; `policy-cases.json` (app/host/page exclusion decisions and their refusals), run by Rust and every helper (`windows/tests/policy.cpp`, built on Linux too; Swift `ScreenExclusionTests`): ADR-DESK-054
├── native/macos/            SwiftPM package: the macOS helpers and their tests (ADR-DESK-044)
│   ├── Package.swift            Products `voice-hotkey`, `voice-macos`, `voice-microphone`, `voice-screen-reader` and `voice-field-reader`, the executables the app spawns
│   ├── Sources/
│   │   ├── VoiceHelperSupport/      The line protocol every helper speaks (requests, replies, events, stderr log lines)
│   │   ├── VoiceHotkey/             `voice-hotkey`'s `main.swift`
│   │   ├── VoiceHotkeyKit/          Event tap + push-to-talk gesture, and `HotkeyService` (its requests)
│   │   ├── VoiceMacOS/              `voice-macos`'s `main.swift`
│   │   ├── VoiceFieldReader/        `voice-field-reader`'s `main.swift` (`FieldReaderService` in `VoiceMacOSKit`)
│   │   ├── VoiceMicrophone/         `voice-microphone`'s `main.swift`
│   │   ├── VoiceMicrophoneKit/      The microphone, in a process of its own that runs one engine, ending itself after each dictation or an input change to be started afresh: `MicrophoneService` (its requests), `MicrophoneCapture` (the engine, prepared ahead), `HelperConfig`
│   │   └── VoiceMacOSKit/           Everything else that needs AppKit or Accessibility; `MacService` (its requests) and `HelperConfig` (its tunable numbers) at the top
│   │       ├── Dictation/               Paste (`TextInserter`; the clipboard saved ahead and put back after by `ClipboardKeeper`, never read by the paste), the caret, the focused field read after a paste and its reader (`FieldReaderService`), the keyboard's language, the screen read and its reader
│   │       ├── Privacy/                 What must not leave the helper: secret-looking text taken out of a screen read (`Redactor` and `SharedContext`, thin adapters to the shared Rust core); the apps and websites a read excludes (`ScreenExclusions`)
│   │       ├── System/                  The Accessibility activator, other apps (frontmost, email apps, icons), the Globe key
│   │       └── Connectors/              What the agent's connectors reach: Calendar and Reminders (`EventStore`), Contacts (`ContactStore`), Spotlight and opening files (`FileSearch`)
│   └── Tests/                   One test target per library; `VoiceMacOSKitTests` in the same folders
├── native/windows/          CMake/MSVC helpers: Win32 hotkey (`voice-hotkey.exe`), UI Automation and paste (`voice-windows.exe`), WASAPI audio (`voice-microphone.exe`), the screen read (`voice-screen-reader.exe`); native tests and build instructions in README.md
├── src/
│   ├── core/                Platform-free logic (DOM lib only; no Node/Electron), ported from the Swift app (folders: ADR-DESK-044)
│   │   ├── config.ts, palette.ts, log.ts, settings.ts   Every tunable number; every color (ADR-DESK-048); the debug-gated log; the settings every part reads
│   │   ├── agent/                   Agent mode (ADR-DESK-011)
│   │   │   ├── requests.ts              `DesktopAgent`: agent mode's one tool loop, ended by a reply or a Compose/Edit write
│   │   │   ├── tools.ts                 Agent mode's own tools, the bubbles: Edit, Compose, Thunderbird, Answer
│   │   │   ├── chat.ts, bubbleOrder.ts  The chat window's conversation; the bubbles' order
│   │   │   └── connectors/              The apps Answer's model reaches on this computer, one file each with its tools (a new connector or tool goes here)
│   │   │       ├── One file per connector, its `defineConnector` and its tools: calendar.ts (Calendar and Reminders), contacts.ts, files.ts (Spotlight), email.ts (a prefilled new email), notes.ts (shared tools; macos/notes.ts owns AppleScript), macos/messages.ts, web.ts (pages read through a `WebFetch`, opened in the browser), pdf.ts (a PDF's pages, through a `PDFReader`)
│   │   │       ├── contract.ts              `Connector` and `defineConnector`, `ConnectorServices` (the OS access), `ConnectorTool` and `Arguments`
│   │   │       ├── registry.ts              AUTO-GENERATED by `npm run gen:registries` (scripts/gen-registries.mts): the connectors, in order
│   │   │       ├── index.ts                 What the app reads: `connectors`, `connectorIDs`, `isConnectorID`, `connectorByID`
│   │   │       ├── macos/appleScript.ts     `ScriptRunner`, for Notes and Messages
│   │   │       └── thunderbird/             `ThunderbirdRelay` (`relay.ts`, to TabMail's chat) and `EmailClient` (the email app it drives); its native connector goes here (ADR-DESK-037)
│   │   ├── dictation/               The dictation state machine (`controller.ts`, settings snapshotted at key-down); `cleanup.ts` (the cleanup's variables, what gets pasted); `chunkJoin.ts` (a long dictation's chunk texts joined: ADR-DESK-049); `screenContext.ts`; `excludedApps.ts` (the apps the screen is never read in: ADR-DESK-045); `excludedSites.ts` (the websites it is never read on, and `ScreenExclusions`, both lists as a dictation takes them: ADR-DESK-047); `pasteHistory.ts` (the texts pasted or copied, in memory, for the triple tap: ADR-DESK-043)
│   │   ├── audio/                   Recording (`recorder.ts`), where a long dictation is cut into chunks (`chunker.ts`: ADR-DESK-049), waveform level, WAV and FLAC
│   │   ├── backend/                 Sign-in (`account.ts`), the transcription and completions clients, their errors, HTTP
│   │   ├── dictionary/              The user's dictionary (`entries.ts`); the words a correction respells; the watch of the pasted-into field that learns them; the names and terms picked from the screen read (ADR-DESK-038)
│   │   ├── hotkey/                  The hotkey, the modes and the gesture's actions (`bindings.ts`); macos/globeKeyAction.ts (the Globe key's own action while fn is it) (ADR-DESK-031)
│   │   ├── onboarding/              The welcome wizard, permissions, tips (the one-time what's-new tip among them), VS Code settings that hide the caret and the wizard's fix (with `jsonc-parser`)
│   │   ├── ui/                      Where the overlay sits; what the tray menu shows
│   │   └── util/                    observable, keyValueStore, timeout, text, localDateTime (the backend's dates in the local zone)
│   ├── main/                The main process (Node + Electron)
│   │   ├── index.ts                 Wires everything: helpers, controller, windows, IPC, tray
│   │   ├── audioCapture.ts          The microphone, one session per try of a dictation's start (a failed start is tried again for about two seconds): through `voice-microphone` on macOS, Windows and Linux, the hidden audio window elsewhere
│   │   ├── windows.ts, overlayWindow.ts, tray.ts   The windows, the overlay at the caret, the menu-bar menu
│   │   ├── documents/               A local file the user approved, for agent mode (ADR-DESK-051): `localDocument.ts` (home folder only, no symlinks, the same file read); the PDF parsed in a disposable utility process (`pdfProcess.ts`, `pdfWorker.ts`) inside a fixed-memory interpreter (`pdfRealm.ts`, `pdfRealmPrelude.ts`, `pdfExtraction.ts`); `pdfReader.ts` (its text redacted in the helper)
│   │   ├── updater.ts               Packaged builds: updates from cdn.tabmail.ai, on every platform: when to look, the download, the states, the question, failures and retries (ADR-DESK-041, ADR-DESK-050); each OS's proof and install in `native/<os>/update.ts`
│   │   ├── native/                  The app's side of the OS: a new platform's helper goes here
│   │   │   ├── helperClient.ts          Spawns a helper, requests with timeouts, events, restarts (at once for a helper that exits to be started afresh)
│   │   │   ├── microphone.ts         Shared native audio wire adapter and chunk decoder
│   │   │   ├── screenReader.ts       The screen read, by `voice-screen-reader`, a program of its own on every platform: restarted when a read is superseded or stuck (ADR-DESK-053)
│   │   │   ├── fieldReader.ts        The focused field read after a paste (`CorrectionWatch`'s `FieldSource`), by `voice-field-reader`, a program of its own on every platform: the paste's own target by an identity both helpers share (the process on macOS and Linux, the window's handle on Windows), restarted when a read is superseded or stuck (ADR-DESK-053, amended 2026-10-07 and 2026-10-08)
│   │   │   ├── macos/                 system.ts, permissions.ts, osascript.ts: Apple framework and AppleScript adapters; update.ts (Squirrel.Mac's proof)
│   │   │   ├── windows/               system.ts, permissions.ts, files.ts: Windows native helper, permissions, Windows Search and File Explorer adapters; update.ts (the installer's Authenticode signature, through `voice-windows.exe --verify-update`)
│   │   │   └── linux/                 gnomeIntegration.ts and the Linux adapters; update.ts (`install-update`, through `pkexec` to install)
│   │   └── storage/                 keychainSessionStore.ts (the sign-in; windows/sessionCredential.ts stores compressed binary sessions within Credential Manager’s blob bound), jsonFileStore.ts (settings), logFile.ts (the debug log), profileFiles.ts (Thunderbird's)
│   ├── preload/index.ts     `window.voice` (sandboxed: imports only electron; channel names written out)
│   ├── shared/ipc.ts        Window states, commands, audio messages, channels, boundary checks
│   └── renderer/            One folder per window: `<page>/index.html` (what Vite builds and the window loads), `index.tsx` and `index.css`
│       ├── overlay/                 The pill, waveform, swirl, tips, bubbles and chat window
│       ├── settings/, welcome/, history/ (the paste history), contextDebug/
│       ├── audio/                   The microphone off macOS: getUserMedia → captureWorklet
│       └── shared/                  The bridge to `window.voice`, the brand, the palette's theme as CSS variables (`theme.ts`), the glass every floating surface is made of (`glass.ts`), icons, the name field, form.css
└── test/                    Vitest, mirroring src/ (a module's test in the same folder); support/ (stubs, fixtures' builders, fake Thunderbird, a fake helper); packaging.test.ts
```

## Naming

What a new file, target or name must match (the folders' rules are ADR-DESK-044's):

| What | Convention | Examples |
|---|---|---|
| TypeScript files and folders | camelCase; an entry point is `index`; no file repeats its folder's name; a platform's own code in a `macos/` or `windows/` folder | `audioCapture.ts`, `native/helperClient.ts`, `agent/chat.ts`, `native/macos/system.ts` |
| TypeScript tests | The module's name and folder under `test/`, ending `.test.ts`; shared stand-ins in `test/support/` | `test/main/audioCapture.test.ts`, `test/support/fakeHelper.mjs` |
| Scripts | kebab-case `.mts` (Node runs them directly); a platform's in its folder | `scripts/build-native.mts`, `scripts/macos/build-native.mts` |
| TypeScript names | Types, classes and React components PascalCase; functions, variables and every constant camelCase (no `SCREAMING_CASE`, `config.ts` included); an error class ends `Error`; a number in `config.ts` says its unit in its comment, and is milliseconds where it is a time | `SessionAudioCapture`, `MicrophoneError`, `microphoneStartTimeout` |
| Helper executables | kebab-case, `voice-<what>` (`.exe` on Windows); the name is also the helper's name in the log | `voice-hotkey`, `voice-macos`, `voice-microphone`, `voice-screen-reader`, `voice-field-reader`, `voice-windows.exe`, `voice-microphone.exe` |
| Swift targets | PascalCase: `Voice<What>` (the executable, only its `main.swift`) over `Voice<What>Kit` (the library), tested by `Voice<What>KitTests` | `VoiceMicrophone`, `VoiceMicrophoneKit`, `VoiceMicrophoneKitTests` |
| Swift files | PascalCase, named for the type declared; a test file is that type's name plus `Tests`, in the same folder under `Tests/`; a kit's requests are its `<What>Service` (an enum with `register(on:)`), its tunable numbers its `HelperConfig` | `MicrophoneCapture.swift`, `MicrophoneCaptureTests.swift`, `MicrophoneService`, `HelperConfig.swift` |
| Swift names | Types PascalCase; functions, properties, constants and enum cases camelCase; a dispatch queue's label is `ai.tabmail.voice.helper.<camelCase>` | `restartExitCode`, `ai.tabmail.voice.helper.microphoneChunks` |
| Windows helper sources | snake_case `.h`/`.cpp`; types PascalCase, functions and variables camelCase, in namespace `voice` | `helper_config.h`, `screen_context.h`, `voice::Microphone` |
| The helpers' wire | Methods, events and their fields camelCase, a concern's methods sharing its prefix; the same names on every platform that has them | `microphoneStart`, `microphoneChunk`, `sampleRate` |
| Decisions | `ADR-DESK-NNN`, the next number; a change to one is a dated **Amendment** under it, never a rewrite | `ADR-DESK-032`, "Amendment 2026-10-01" |

## Flow

`voice-hotkey` (`HotkeyMonitor` → `PushToTalkGesture`) sends each gesture action to the main
process, which hands it to `DictationController` (`src/core/dictation/controller.ts`):

1. **start** (key-down; consent given in the welcome wizard, signed in, both permissions): phase `arming`, nothing shown.
   The microphone starts (`SessionAudioCapture` → `voice-microphone`'s `MicrophoneCapture`, its engine
   prepared ahead) and streams samples into `AudioRecorder`; `voice-macos` finds the caret; the
   keyboard's language is read once, for the overlay's badge and the transcription request; the app in
   front is kept (`targetApp`), the only app the text may be pasted into (ADR-DESK-042). After
   `minimumHoldDuration` the phase becomes `listening` and the overlay appears at the caret (swirl
   until audio arrives, then the waveform pill). Releasing earlier discards everything unseen.
2. **finish**: the mic keeps recording `releaseTailDuration`, then stops. No audio, or an empty
   transcript, shows "Didn't catch that". Otherwise the WAV is uploaded via
   `TranscriptionClient` (one forced-refresh retry on 401) with the cleanup's variables: the screen
   context read at key-down (`ScreenContextProbe`, waited for up to `contextWait`) and the
   dictionary. The backend transcribes it and runs the cleanup prompt in the same request, under its
   own deadline (backend ADR-027), and `voice-macos` pastes the cleaned text into the focused field
   (`TextInserter`), then puts back the newest clipboard it saved, asked for every
   `clipboardSaveInterval` from key-down until the paste writes (`clipboardSave`, `ClipboardKeeper`:
   ADR-DESK-002, amended 2026-10-08 and 2026-10-09); with another app in front
   than at key-down (`focusChanged`), nothing is pasted or copied, and a note at the mouse pointer
   offers to copy it for 10 s (phase `notPasted`, carrying the text: a card showing it in a box with a copy sign; a click anywhere on it copies it and the note goes, its x dismisses it). Either way the text joins
   the paste history. If the cleanup failed for any reason, the transcript
   is pasted as heard (`DictationCleanup`). A long dictation (up to `maxRecordingDuration`, 10 min) is
   cut into chunks of up to 105 s, each overlapping the one before, as it is recorded (`Chunker`; cuts at pauses are off since 2026-10-07), each sent with its cleanup while the user
   goes on and retried in the background; at the release the last chunk is sent and the texts are
   joined in order (`joinChunkTexts`), up to the first chunk that gave up (ADR-DESK-049).
3. **cancel** (another key pressed during the hold): recording or upload is discarded; nothing
   is inserted.

A `generation` counter makes callbacks from a superseded dictation no-ops.

**Hands-free** (a tap, then a press within `doubleTapWindow`; ADR-DESK-021): the overlay shows at
once and the dictation goes on without the key until the hotkey is tapped again (finish) or Escape
(cancel); Space still switches the mode. A third press within `doubleTapWindow` (a triple tap)
opens the paste history instead, where the chat window opens, by the pill (ADR-DESK-043). **Tips** (`DictationTip`, under the listening pill): the Space
tip as a hold starts listening, the double-tap tip once a hold passes 20 s; each shows until learned
or shown its maximum number of times (`TipBook`, kept in the settings file). The hands-free tip ("tap the hotkey to
finish, or Escape to cancel") shows once the second press is released as a tap and stays up while
listening, over the pill when the overlay opened above the caret's line; it is never learned.

**Agent mode** (Space pressed during the hold, again to switch back; ADR-DESK-011): the same
recording and transcription, with the tool bubbles around the pill (ADR-DESK-033): Edit when text is selected,
Compose when not, and Answer (Thunderbird's tool, for when an email app is set up, is off until its
native connector: ADR-DESK-037); each only while switched on
in Settings (ADR-DESK-022), and with Answer a bubble for each app switched on. The transcript is a request,
carried out by one tool loop (`DesktopAgent.run`, the backend's `system_prompt_desktop_agent_loop`, from 0.2.0;
ADR-DESK-055): the backend's date tools and web search run there, and tools that run on this computer
(`ConnectorTool`) run in the app, shown in the chat window, asking first before sending or creating.
The selection's writing tool, Edit or Compose, takes the final text and ends the request: the chat
window closes and the text is pasted (Edit over the selection, Compose at the caret). A plain reply
opens a chat window over the pill, which rests there (ADR-DESK-036), and while it is open the hotkey
asks a follow-up carrying the conversation, until Escape, its X or 30 untouched seconds close it. The
phase is `running(null)` while the loop thinks (no bubble circles; the pill's rim does), then
`running(tool)` once the agent answers or writes (that bubble moves to the front of the row under the
pill and its border circles, as the pill's does; while one of Answer's apps runs a tool, that app's
bubble is the one in front and circling: one bubble runs at a time). The chat window opens only for a
reply or a tool's question (ADR-DESK-055 amendment 2026-10-07). A failure shows a
message and pastes nothing. No agent call has a deadline.

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: macos`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Debug mode" switch, shown only to allowed accounts (ADR-DESK-018): it sends
dictation to dev.tabmail.ai and shows the menu's Start Dictation and debug items.
Packaged builds update themselves from `cdn.tabmail.ai/releases/voice/<os>-<arch>/` (`latest-mac.yml`,
`latest.yml` on Windows, `latest-linux.yml` or `latest-linux-arm64.yml`) with `electron-updater`, sending no installation
ID (ADR-DESK-041, ADR-DESK-050).
