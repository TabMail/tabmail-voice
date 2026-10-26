# The `apps/desktop/` file tree, file by file

Routed verbatim from `PROJECT_STRUCTURE.md` (lines 16-101 at 45d9c585).

## `apps/desktop/`: the Electron app (ADR-DESK-032)

The app for macOS, Windows and Linux. TypeScript,
Electron 44, React 19, Vite, Vitest, electron-builder; npm (`npx -y npm@11.19.1 install`).

```
apps/desktop/
├── package.json, electron-builder.json, tsconfig.{base,main,renderer,test}.json, vite.config.mts, vitest.config.mts, eslint.config.mjs
├── resources/               App icon, tray template images (plain, and marked with a dot while a permission is missing), DMG window background (1x, 2x), macOS entitlements (electron-builder's buildResources); linux/tabmail-voice.sources and linux/tabmail-voice-archive-keyring.gpg, the apt source and the keys that sign it, which the package installs (ADR-DESK-058); windows/installer.nsh, the installer's check and install of the system-wide Visual C++ runtime (ADR-DESK-057)
├── scripts/
│   ├── build-native.mts         Shared dispatcher; macos/build-native.mts (SwiftPM, for `VOICE_MAC_ARCH` arm64, x64 or universal, with both architectures' lockfile-pinned Mac packages) and windows/build-native.mts (CMake/MSVC) copy helpers into dist/helpers
│   ├── memory-helper.mts        Builds `voice-memory`, Thunderbird's search helper, from `TabMail/tabmail-native-fts` at the commit `native/memory/native-fts.json` pins (fetched into `native/memory/.build`, with the app's Rust toolchain and the helper's own Cargo.lock), for every platform's build (ADR-DESK-061)
│   ├── home-folder.mts          The Rust builds' `CARGO_ENCODED_RUSTFLAGS` that build source paths under the home folder as `~`, and the check that refuses a built helper still holding the home folder (it names the builder's user)
│   ├── gen-registries.mts       Writes src/core/agent/connectors/registry.ts from each connector's `defineConnector` (run before build, typecheck and test)
│   ├── swift-errors.sh          Runs a SwiftPM command in native/macos, printing only diagnostics and summaries; `test` runs the shared Rust core's `cargo test` first
│   └── preview/                 `npm run preview`: renders the overlay, Settings and welcome windows with sample states offscreen, saved as PNGs; exits 1 when a shot fails its checks (a page error, something cut off, the not-pasted note's layout as Chromium lays it out)
├── native/shared/rust/      Shared static library, the ONE home of logic the helpers share (ADR-DESK-054; native code is thin OS adapters): redaction, context normalization/rendering, exclusion/address policy, terminal viewport (and the box around its cursor, `terminal_box`), gesture transitions and the microphone's sessions; Swift/C++ C ABI adapters; locked toolchain and conformance tests
├── native/shared/context/   Screen context types and cross-platform context fixtures; `screen-cases.json` (the screen read's whole reply, built by the Rust `screen` op) `request-cases.json` (a field read's bound and reply and a paste's text and deadline, the Rust `request` op) `surface-cases.json` (a terminal surface's runs, selection and caret, the Rust `viewport` op's `surface` request; macOS and Linux) and `walk-cases.json` (the screen walk's steps, the Rust `walk` op; `walk.h` is its C++ wrapper, Swift `SharedWalk`; `walk::LastReadWindow`, the window a bound whole-window read must be, tested by `last-read-window-test.cpp` on Windows and Linux), run by Rust and the helpers (`windows/tests/screen-reply.cpp` and `core-cases.cpp`, built on Linux too; Swift `RedactorTests`): ADR-DESK-054
├── native/shared/microphone/ `voice-microphone`'s shared parts on every platform: `session-cases.json` (which session runs and when the process ends, the Rust `microphone` state; `sessions.h` is its C++ wrapper, Swift `MicrophoneSessions`), run by Rust, Swift and `session-test.cpp` (Windows, Linux); `protocol.mjs`, the Windows and Linux helpers' wire checks: ADR-DESK-032
├── native/shared/privacy/   What every platform's helper shares: `redactors.json` (what looks like a secret in text read off the screen) and `redaction-cases.json` (what each helper must do with it): ADR-DESK-046; `host-exclusion-cases.json` (host matching) and `address-cases.json` (shared URL classification): ADR-DESK-047; `policy-cases.json` (app/host/page exclusion decisions and their refusals), run by Rust and every helper (`windows/tests/policy.cpp`, built on Linux too; Swift `ScreenExclusionTests`): ADR-DESK-054
├── native/memory/           `native-fts.json`, the one commit of `TabMail/tabmail-native-fts` the memory helper is built from (a move to a newer helper changes only it); no source of that repository is kept here (ADR-DESK-061)
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
│   │       ├── Dictation/               Paste (`TextInserter`; the clipboard saved ahead and put back by `ClipboardKeeper` once the target reads the paste's text, offered by `OfferedText`; never read by the paste), the caret, the focused field read after a paste and its reader (`FieldReaderService`), the keyboard's language, the screen read and its reader
│   │       ├── Privacy/                 What must not leave the helper: secret-looking text taken out of a screen read (`Redactor` and `SharedContext`, thin adapters to the shared Rust core); the apps and websites a read excludes (`ScreenExclusions`)
│   │       ├── System/                  The Accessibility activator, other apps (frontmost, email apps, icons), the Globe key
│   │       └── Connectors/              What the agent's connectors reach: Calendar and Reminders (`EventStore`; inviting through Calendar's own methods, `Invitations`, ADR-DESK-060), Contacts (`ContactStore`), Spotlight and opening files (`FileSearch`)
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
│   │   │       ├── One file per connector, its `defineConnector` and its tools: calendar.ts (Calendar and Reminders), contacts.ts, files.ts (Spotlight), email.ts (a prefilled new email), notes.ts (shared tools; macos/notes.ts owns AppleScript), macos/messages.ts, web.ts (pages read through a `WebFetch`, opened in the browser), pdf.ts (a PDF's pages, through a `PDFReader`), settings.ts (`change_setting`, Voice's own settings: the default event duration, ADR-DESK-062)
│   │   │       ├── contract.ts              `Connector` and `defineConnector`, `ConnectorServices` (the OS access), `ConnectorTool` and `Arguments`
│   │   │       ├── registry.ts              AUTO-GENERATED by `npm run gen:registries` (scripts/gen-registries.mts): the connectors, in order
│   │   │       ├── index.ts                 What the app reads: `connectors`, `connectorIDs`, `isConnectorID`, `connectorByID`
│   │   │       ├── macos/appleScript.ts     `ScriptRunner`, for Notes and Messages
│   │   │       └── thunderbird/             `ThunderbirdRelay` (`relay.ts`, to TabMail's chat) and `EmailClient` (the email app it drives); its native connector goes here (ADR-DESK-037)
│   │   ├── dictation/               The dictation state machine (`controller.ts`, settings snapshotted at key-down); `cleanup.ts` (the cleanup's variables, what gets pasted); `chunkJoin.ts` (a long dictation's chunk texts joined: ADR-DESK-049); `screenContext.ts`; `excludedApps.ts` (the apps the screen is never read in: ADR-DESK-045); `excludedSites.ts` (the websites it is never read on, and `ScreenExclusions`, both lists as a dictation takes them: ADR-DESK-047); `pasteHistory.ts` (the texts pasted or copied, in memory, for the triple tap: ADR-DESK-043)
│   │   ├── audio/                   Recording (`recorder.ts`), where a long dictation is cut into chunks (`chunker.ts`: ADR-DESK-049), waveform level and the voice band a voice is told in (`levelSampler.ts`, `levelEnvelope.ts`, `voiceBand.ts`), WAV and FLAC
│   │   ├── backend/                 Sign-in (`account.ts`), the transcription and completions clients, their errors, HTTP
│   │   ├── dictionary/              The user's dictionary (`entries.ts`); the words a correction respells; the watch of the pasted-into field that learns them; the names and terms picked from the screen read (ADR-DESK-038)
│   │   ├── memory/                  Memory, every agent-mode request and what came of it, on this computer (ADR-DESK-061): `store.ts` (`AgentMemory`, the row Thunderbird's add-on writes), `tools.ts` (`memory_search` and `memory_read`, answering as Thunderbird's), `page.ts` (Settings › Memory: the usage bar, the size limit, the list, search, remove and Clear All)
│   │   ├── hotkey/                  The hotkey, the modes and the gesture's actions (`bindings.ts`); macos/globeKeyAction.ts (the Globe key's own action while fn is it) (ADR-DESK-031)
│   │   ├── onboarding/              The welcome wizard, permissions, tips (the one-time what's-new tip among them), VS Code settings that hide the caret and the wizard's fix (with `jsonc-parser`)
│   │   ├── ui/                      Where the overlay sits; what the tray menu shows
│   │   └── util/                    observable, keyValueStore, timeout, text, localDateTime (the backend's dates in the local zone)
│   ├── main/                The main process (Node + Electron)
│   │   ├── index.ts                 Wires everything: helpers, controller, windows, IPC, tray
│   │   ├── audioCapture.ts          The microphone, one session per try of a dictation's start (a failed start is tried again for about two seconds): through `voice-microphone` on macOS, Windows and Linux, the hidden audio window elsewhere
│   │   ├── windows.ts, overlayWindow.ts, tray.ts   The windows, the overlay at the caret, the menu-bar menu
│   │   ├── documents/               A local file the user approved, for agent mode (ADR-DESK-051): `localDocument.ts` (home folder only, no symlinks, the same file read); the PDF parsed in a disposable utility process (`pdfProcess.ts`, `pdfWorker.ts`) inside a fixed-memory interpreter (`pdfRealm.ts`, `pdfRealmPrelude.ts`, `pdfExtraction.ts`); `pdfReader.ts` (its text redacted in the helper)
│   │   ├── updater.ts               Packaged macOS and Windows builds, and the Linux AppImage: updates from cdn.tabmail.ai: when to look, the download, the states, the question, failures and retries (ADR-DESK-041, ADR-DESK-050); each OS's proof and install in `native/<os>/update.ts` (the Linux package has none: apt updates it, ADR-DESK-058; the AppImage's, ADR-DESK-059)
│   │   ├── native/                  The app's side of the OS: a new platform's helper goes here
│   │   │   ├── helperClient.ts          Spawns a helper, requests with timeouts, events, restarts (at once for a helper that exits to be started afresh)
│   │   │   ├── memoryHelper.ts          Memory, kept by `voice-memory` over Thunderbird's native messaging (4-byte length, then JSON), in `userData/memory` (database, models; the helper writes no log): started on first use, ended when unused (ADR-DESK-061)
│   │   │   ├── microphone.ts         Shared native audio wire adapter and chunk decoder
│   │   │   ├── screenReader.ts       The screen read, by `voice-screen-reader`, a program of its own on every platform: restarted when a read is superseded or stuck (ADR-DESK-053)
│   │   │   ├── fieldReader.ts        The focused field read after a paste (`CorrectionWatch`'s `FieldSource`), by `voice-field-reader`, a program of its own on every platform: the paste's own target by an identity both helpers share (the process on macOS and Linux, the window's handle on Windows), restarted when a read is superseded or stuck (ADR-DESK-053, amended 2026-10-07 and 2026-10-08)
│   │   │   ├── macos/                 system.ts, permissions.ts, osascript.ts: Apple framework and AppleScript adapters; update.ts (Squirrel.Mac's proof)
│   │   │   ├── windows/               system.ts, permissions.ts, files.ts: Windows native helper, permissions, Windows Search and File Explorer adapters; update.ts (the installer's Authenticode signature, through `voice-windows.exe --verify-update`)
│   │   │   └── linux/                 gnomeIntegration.ts and the Linux adapters; appImage.ts (the AppImage's launcher entry, icons and extension in the user's data folder) and update.ts (the AppImage's updates, `gpgv` over the release's signed statement; the package has none: apt updates it, ADR-DESK-058, ADR-DESK-059)
│   │   └── storage/                 keychainSessionStore.ts (the sign-in; windows/sessionCredential.ts stores compressed binary sessions within Credential Manager’s blob bound), jsonFileStore.ts (settings), logFile.ts (the debug log), profileFiles.ts (Thunderbird's)
│   ├── preload/index.ts     `window.voice` (sandboxed: imports only electron; channel names written out)
│   ├── shared/ipc.ts        Window states, commands, audio messages, channels, boundary checks
│   └── renderer/            One folder per window: `<page>/index.html` (what Vite builds and the window loads), `index.tsx` and `index.css`
│       ├── overlay/                 The pill, waveform, swirl, tips, bubbles and chat window
│       ├── settings/, welcome/, history/ (the paste history), contextDebug/
│       ├── audio/                   The microphone off macOS: getUserMedia → captureWorklet
│       └── shared/                  The bridge to `window.voice`, the brand, the palette's theme as CSS variables (`theme.ts`), the glass every floating surface is made of (`glass.ts`), icons, the name field, form.css
└── test/                    Vitest, mirroring src/ (a module's test in the same folder); support/ (stubs, fixtures' builders, fake Thunderbird, a fake helper, a fake memory and memory helper); packaging.test.ts
```
