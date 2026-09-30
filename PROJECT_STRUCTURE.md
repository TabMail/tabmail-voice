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
├── resources/               App icon, tray template images, DMG window background (1x, 2x), macOS entitlements (electron-builder's buildResources)
├── scripts/
│   ├── build-native.mts         Builds the platform's helpers into dist/helpers (macOS: SwiftPM, arm64)
│   ├── swift-errors.sh          Runs a SwiftPM command in native/macos, printing only diagnostics and summaries
│   └── preview/                 `npm run preview`: renders the overlay, Settings and welcome windows with sample states offscreen, saved as PNGs
├── native/macos/            SwiftPM package: the macOS helpers and their tests (ADR-DESK-044)
│   ├── Package.swift            Products `voice-hotkey` and `voice-macos`, the executables the app spawns
│   ├── Sources/
│   │   ├── VoiceHelperSupport/      The line protocol both helpers speak (requests, replies, events, stderr log lines)
│   │   ├── VoiceHotkey/             `voice-hotkey`'s `main.swift`
│   │   ├── VoiceHotkeyKit/          Event tap + push-to-talk gesture, and `HotkeyService` (its requests)
│   │   ├── VoiceMacOS/              `voice-macos`'s `main.swift`
│   │   └── VoiceMacOSKit/           Everything else that needs AppKit or Accessibility; `MacService` (its requests) and `HelperConfig` (its tunable numbers) at the top
│   │       ├── Dictation/               Paste and clipboard restore, the microphone, the caret, the focused field read after a paste, the keyboard's language, the screen read and its reader
│   │       ├── System/                  The Accessibility activator, other apps (frontmost, email apps, icons), the Globe key
│   │       └── Connectors/              What the agent's connectors reach: Calendar and Reminders (`EventStore`), Contacts (`ContactStore`), Spotlight and opening files (`FileSearch`)
│   └── Tests/                   One test target per library; `VoiceMacOSKitTests` in the same folders
├── src/
│   ├── core/                Platform-free logic (DOM lib only; no Node/Electron), ported from the Swift app (folders: ADR-DESK-044)
│   │   ├── config.ts, log.ts, settings.ts   Every tunable number; the debug-gated log; the settings every part reads
│   │   ├── agent/                   Agent mode (ADR-DESK-011)
│   │   │   ├── requests.ts              `DesktopAgent`: picks the tool, has it write, runs Answer's tool loop
│   │   │   ├── tools.ts                 Agent mode's own tools, the bubbles: Edit, Compose, Thunderbird, Answer
│   │   │   ├── chat.ts, bubbleOrder.ts  The chat window's conversation; the bubbles' order
│   │   │   └── connectors/              The apps Answer's model reaches on this computer, one file each with its tools (a new connector or tool goes here)
│   │   │       ├── calendar.ts (Calendar and Reminders), contacts.ts, files.ts (Spotlight), email.ts (a prefilled new email), notes.ts, messages.ts, web.ts (pages read through a `WebFetch`, opened in the browser)
│   │   │       ├── registry.ts              The connectors, each a switch: names, their backend tools
│   │   │       ├── tool.ts                  `ConnectorTool`, the contract, and `Arguments`
│   │   │       ├── appleScript.ts           `ScriptRunner`, for Notes and Messages
│   │   │       └── thunderbird/             `ThunderbirdRelay` (`relay.ts`, to TabMail's chat) and `EmailClient` (the email app it drives); its native connector goes here (ADR-DESK-037)
│   │   ├── dictation/               The dictation state machine (`controller.ts`, settings snapshotted at key-down); `cleanup.ts` (the cleanup's variables, what gets pasted); `screenContext.ts`; `pasteHistory.ts` (the texts pasted or copied, in memory, for the triple tap: ADR-DESK-043)
│   │   ├── audio/                   Recording (`recorder.ts`), waveform level, WAV and FLAC
│   │   ├── backend/                 Sign-in (`account.ts`), the transcription and completions clients, their errors, HTTP
│   │   ├── dictionary/              The user's dictionary (`entries.ts`); the words a correction respells; the watch of the pasted-into field that learns them; the names and terms picked from the screen read (ADR-DESK-038)
│   │   ├── hotkey/                  The hotkey, the modes and the gesture's actions (`bindings.ts`); the Globe key's own action while fn is it (ADR-DESK-031)
│   │   ├── onboarding/              The welcome wizard, permissions, tips, VS Code settings that hide the caret and the wizard's fix (with `jsonc-parser`)
│   │   ├── ui/                      Where the overlay sits; what the tray menu shows
│   │   └── util/                    observable, keyValueStore, timeout, text, localDateTime (the backend's dates in the local zone)
│   ├── main/                The main process (Node + Electron)
│   │   ├── index.ts                 Wires everything: helpers, controller, windows, IPC, tray
│   │   ├── audioCapture.ts          The microphone, one session per dictation: through `voice-macos` on macOS, the hidden audio window elsewhere
│   │   ├── windows.ts, overlayWindow.ts, tray.ts   The windows, the overlay at the caret, the menu-bar menu
│   │   ├── updater.ts               Packaged builds: updates from cdn.tabmail.ai, installed at the quit, "Restart now?" once ready (ADR-DESK-041)
│   │   ├── permissions.ts           The OS permissions, asked and read
│   │   ├── native/                  The app's side of the OS: a new platform's helper goes here
│   │   │   ├── helperClient.ts          Spawns a helper, requests with timeouts, events, restarts
│   │   │   ├── macos.ts                 `voice-macos`'s methods, typed
│   │   │   └── osascript.ts             Notes' and Messages' AppleScripts, run by `/usr/bin/osascript` (arguments after `--`; a canceled request ends it)
│   │   └── storage/                 keychainSessionStore.ts (the sign-in), jsonFileStore.ts (settings), logFile.ts (the debug log), profileFiles.ts (Thunderbird's)
│   ├── preload/index.ts     `window.voice` (sandboxed: imports only electron; channel names written out)
│   ├── shared/ipc.ts        Window states, commands, audio messages, channels, boundary checks
│   └── renderer/            One folder per window: `<page>/index.html` (what Vite builds and the window loads), `index.tsx` and `index.css`
│       ├── overlay/                 The pill, waveform, swirl, tips, bubbles and chat window
│       ├── settings/, welcome/, history/ (the paste history), contextDebug/
│       ├── audio/                   The microphone off macOS: getUserMedia → captureWorklet
│       └── shared/                  The bridge to `window.voice`, the brand, icons, the name field, form.css
└── test/                    Vitest, mirroring src/ (a module's test in the same folder); support/ (stubs, fixtures' builders, fake Thunderbird, a fake helper); packaging.test.ts
```

## Flow

`voice-hotkey` (`HotkeyMonitor` → `PushToTalkGesture`) sends each gesture action to the main
process, which hands it to `DictationController` (`src/core/dictation/controller.ts`):

1. **start** (key-down; consent given in the welcome wizard, signed in, both permissions): phase `arming`, nothing shown.
   The microphone starts (`SessionAudioCapture` → `voice-macos`'s `MicrophoneCapture`, its engine
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
   own deadline (backend ADR-027), and `voice-macos` pastes the cleaned text into the focused field,
   restoring the clipboard (`TextInserter`); with another app in front than at key-down
   (`focusChanged`), nothing is pasted and the text is left on the clipboard, with a note at the mouse
   pointer (phase `copied`). Either way the text joins the paste history. If the cleanup failed for any reason, the transcript
   is pasted as heard (`DictationCleanup`).
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
in Settings (ADR-DESK-022), and with Answer a bubble for each app switched on. The transcript is a request: `DesktopAgent.tool` picks among the tools
offered (asking the backend's `system_prompt_desktop_agent`, with them in `available_tools`, unless
only one is on), the phase becomes `running(tool)` (that bubble moves to the front of the row under
the pill and its border circles, as the pill's does), and `DesktopAgent.write` has the tool's prompt
write the text. Edit pastes over the selection; Compose pastes at the caret; Thunderbird sends it to
TabMail's chat; Answer opens a chat window over the pill, which rests there (ADR-DESK-036), and while
it is open the hotkey asks a follow-up carrying the conversation, until Escape, its X or 30 untouched
seconds close it. Answer's prompt runs the backend's tool loop (`DesktopAgent.answer`,
ADR-DESK-023): the backend's date tools run there, and tools that run on this computer (`ConnectorTool`)
run in the app, shown in the chat window, asking first before sending or creating. A failure shows a
message and pastes nothing. No agent call has a deadline.

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: macos`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Debug mode" switch, shown only to allowed accounts (ADR-DESK-018): it sends
dictation to dev.tabmail.ai and shows the menu's Start Dictation and debug items.
Packaged builds update themselves from `cdn.tabmail.ai/releases/voice/macos-arm64/latest-mac.yml`
(`electron-updater`), sending no installation ID (ADR-DESK-041).
