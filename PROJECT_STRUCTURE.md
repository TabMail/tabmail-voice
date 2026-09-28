# TabMail Voice — Project Structure

macOS menu-bar dictation app: hold a key, speak, and the text is typed into whatever field has
focus. Speech is transcribed by the TabMail backend (`POST /dictation/transcribe` → OpenRouter).
Swift 6 / SwiftUI + AppKit, macOS 15+, XcodeGen.

```
tabmail-voice/
├── Secrets.xcconfig.example    → copy to gitignored Secrets.xcconfig (DEVELOPMENT_TEAM); loaded via configFiles
├── Scripts/copy-worktree-secrets.sh  Installs the primary's gitignored signing config into a worktree, unprinted
└── apps/                     One folder per platform (ADR-DESK-013)
    └── macos/                The macOS app
        ├── project.yml                 XcodeGen spec (app + unit tests). Generate via apps/macos/Scripts/xcodegen.sh
        ├── Scripts/xcodegen.sh         Generates TabMailVoice.xcodeproj with the signing team injected
        ├── TabMailVoice/
        │   ├── App/
        │   │   ├── TabMailVoiceApp.swift     @main: MenuBarExtra + Settings scenes; AppDelegate wires everything, opens the welcome wizard until finished
        │   │   └── AppSettings.swift         Hotkey, screen reading, consent, wizard finished (UserDefaults); open-at-login (SMAppService)
        │   ├── Account/
        │   │   ├── AccountModel.swift        Signed-in session; single-flight token refresh (refresh tokens are single-use)
        │   │   ├── DebugAccess.swift       Accounts allowed debug mode (same as iOS DebugModeManager)
        │   │   ├── AuthClient.swift          Supabase email one-time-code sign-in + refresh; injectable HTTPTransport
        │   │   ├── SessionStore.swift        Keychain session storage (SessionStoring protocol)
        │   │   └── TabMailSession.swift      GoTrue session wire model (same shape as iOS)
        │   ├── Agent/                    Agent mode (ADR-DESK-020: one file per tool, one folder per connector)
        │   │   ├── DesktopAgent.swift        Which tools are offered; one call chooses the tool, one has it write the text
        │   │   ├── AgentTool.swift           Tool registry: `AgentTool` enum (the name the agent answers) → its `DesktopTool`; `ToolContext` a tool delivers with
        │   │   ├── Tools/
        │   │   │   ├── EditTool.swift            Rewrites the selection; fitted to its blank space, pasted over it
        │   │   │   ├── ComposeTool.swift         Writes at the caret (gets the terminal program)
        │   │   │   └── ThunderbirdTool.swift     Hands a mail/calendar request to the Thunderbird connector
        │   │   └── Connectors/
        │   │       └── Thunderbird/
        │   │           ├── EmailClient.swift         The email app the Thunderbird tool drives: chosen in Settings, else the default email app if it is a Thunderbird
        │   │           └── ThunderbirdRelay.swift    Types a chat message into TabMail's chat in Thunderbird: front, ⌥⌘L, paste, Return, only while the chat has focus (spike)
        │   ├── Backend/
        │   │   ├── BackendError.swift        Backend HTTP error → user message
        │   │   ├── TranscriptionClient.swift POST /dictation/transcribe, with the dictation's language (the backend picks the model by it)
        │   │   ├── CompletionsClient.swift   POST /completions/chat with one named backend prompt; reply from the SSE `final` event (as iOS)
        │   │   └── BackendLog.swift          A backend request and its raw reply as the debug log file shows them (access token masked, audio left out)
        │   ├── Config/DictationConfig.swift  Every tunable number and endpoint (timings, audio, backend, auth, overlay)
        │   ├── Context/                  Screen context read at key-down, for the transcript cleanup
        │   │   ├── ScreenContext.swift       App, host, terminal program, caret text, visible text blocks with frames, laid out in lines as on screen
        │   │   ├── ScreenContextReader.swift Accessibility walk of the focused window (through `ScreenTree`, faked in tests); tmux pane for terminals
        │   │   └── ScreenContextProbe.swift  Captures at key-down (when screen reading is on) in the background; the cleanup waits up to `contextWait` for it; latest kept for the debug window
        │   ├── Dictation/
        │   │   ├── DictationController.swift State machine idle → arming → listening → transcribing → idle/failed; 401 retry
        │   │   ├── DictationCleanup.swift    The cleanup call: transcript + screen context; the transcript as heard if it fails
        │   │   ├── MicrophoneCapture.swift   System default mic; engine pre-prepared (mic off), started per dictation on a serial queue; `AudioCapturing` (tests inject a silent one)
        │   │   ├── AudioRecorder.swift       Converts to 16 kHz mono Int16, accumulates, tracks peak, caps duration
        │   │   ├── KeyboardLanguage.swift    The active keyboard input source's language as an ISO-639-1 code (ADR-DESK-019)
        │   │   ├── LevelEnvelope.swift       Waveform level adapted to the incoming range (EMA floor/peak envelopes)
        │   │   └── WAVEncoder.swift          44-byte RIFF header around the PCM
        │   ├── Hotkey/
        │   │   ├── PushToTalkGesture.swift   Pure recogniser: press → start, release → finish, chord → cancel; Space during the hold → toggle agent mode; tap + press → hands-free dictation until the next tap (Escape cancels)
        │   │   ├── HotkeyMonitor.swift       Keyboard CGEventTap feeding the gesture; keeps the mode-switching Space (and hands-free Escape) from the app in front
        │   │   └── GlobeKeyAction.swift      While fn is the hotkey, macOS's own Globe action is Do Nothing; the user's choice comes back after (ADR-DESK-031)
        │   ├── Insertion/
        │   │   ├── TextInserter.swift        Paste-and-restore insertion; PasteboardSnapshot
        │   │   ├── CaretLocator.swift        Caret (else focused field) rect via Accessibility (anchors the overlay)
        │   │   └── AccessibilityActivator.swift  Asks Gecko/Electron apps to build their tree as they come to the front
        │   ├── Onboarding/
        │   │   ├── WelcomeWizard.swift     Welcome wizard steps and navigation (ADR-DESK-010): consent → permissions → features
        │   │   └── DictationTips.swift     TipKit-style tips by the pill (Space switches the mode; double-tap to dictate hands-free; how hands-free listening ends), retired once learned, texts and counts in `DictationConfig.TipSettings` (ADR-DESK-021)
        │   ├── Permissions/PermissionsModel.swift  Microphone + Accessibility status, prompts, grant polling, grant callbacks
        │   ├── Support/Log.swift             Debug-gated os.Logger (`debug`/`error` never carry transcript content); debug builds also append to ~/Library/Logs/TabMail Voice/TabMail Voice.log (`LogFile`, menu › Show Log File), where `Log.content` also writes user content in full (ADR-DESK-015)
        │   └── UI/
        │       ├── MenuContent.swift         Menu-bar menu (Start Dictation and debug items in debug mode only)
        │       ├── SettingsView.swift        Settings window
        │       ├── WelcomeView.swift         Welcome wizard: Thunderbird-style top rail, step pages, Back / Next
        │       ├── WelcomeWindowController.swift  Opens the wizard window (one at a time)
        │       ├── ScreenContextDebugView.swift  Debug builds: "Show Last Screen Context" window
        │       └── OverlayPanel.swift        Non-activating overlay at the caret: warm-up swirl → voice waveform pill (the dictation's language in a small circle left of the waveform) → spinning circle while transcribing; a dark tooltip under the listening pill with the controller's tip (`TipTooltip`), fading after a moment, or the hands-free tip, up while it listens and over the pill when the overlay opened above the caret's line; agent mode's icon-only tool bubbles in a row above it, the running one's border circling
        │   └── Resources/Assets.xcassets     AppIcon (from the iOS icon) + MenuBarIcon template glyph
        └── TabMailVoiceTests/          Swift Testing suites (see TESTS.md)
```

## `apps/desktop/`: the Electron app (ADR-DESK-032)

The unified app for macOS, Windows and Linux that replaces `apps/macos/` once at parity. TypeScript,
Electron 44, React 19, Vite, Vitest, electron-builder; npm (`npx -y npm@11.19.1 install`).

```
apps/desktop/
├── package.json, electron-builder.json, tsconfig.{base,main,renderer,test}.json, vite.config.mts, vitest.config.mts, eslint.config.mjs
├── resources/               App icon, tray template images, macOS entitlements (electron-builder's buildResources)
├── scripts/
│   ├── build-native.mts         Builds the platform's helpers into dist/helpers (macOS: SwiftPM, arm64)
│   ├── swift-errors.sh          Runs a SwiftPM command in native/macos, printing only diagnostics and summaries
│   └── preview/                 `npm run preview`: renders every window with sample states offscreen, saved as PNGs
├── native/macos/            SwiftPM package: the macOS helpers and their tests
│   ├── Sources/VoiceHelperSupport/  The line protocol (requests, replies, events, debug-gated stderr)
│   ├── Sources/VoiceHotkeyKit/      Event tap + push-to-talk gesture (`voice-hotkey`)
│   └── Sources/VoiceMacOSKit/       Paste/restore, screen read, caret, keyboard language, Globe, activator, email apps, Thunderbird, the microphone (`voice-macos`)
├── src/
│   ├── core/                Platform-free logic (DOM lib only; no Node/Electron): the Swift app's port
│   │   ├── dictationController.ts   The dictation state machine; settings snapshotted at key-down
│   │   ├── account.ts, backend.ts, cleanup.ts, http.ts   Sign-in, transcription/completions clients, cleanup
│   │   ├── agent/                   DesktopAgent, the tools, EmailClient, ThunderbirdRelay
│   │   ├── audio.ts, levelEnvelope.ts, wav.ts   Recording, waveform level, WAV
│   │   ├── settings.ts, permissions.ts, tips.ts, welcomeWizard.ts, globeKeyAction.ts, screenContext.ts
│   │   ├── overlayGeometry.ts, menuModel.ts   Where the overlay sits; what the tray menu shows
│   │   └── config.ts, log.ts, observable.ts, keyValueStore.ts, timeout.ts, text.ts, hotkey.ts
│   ├── main/                The main process (Node + Electron)
│   │   ├── main.ts                  Wires everything (the Swift AppDelegate): helpers, controller, windows, IPC, tray
│   │   ├── helperClient.ts          Spawns a helper, requests with timeouts, events, restarts
│   │   ├── macos.ts                 `voice-macos`'s methods, typed
│   │   ├── audioCapture.ts          The microphone, one session per dictation: through `voice-macos` on macOS, the hidden audio window elsewhere
│   │   ├── windows.ts, overlayWindow.ts, tray.ts   The windows, the overlay at the caret, the menu-bar menu
│   │   ├── permissions.ts, keychainSessionStore.ts, fileStore.ts, logFile.ts, profileFiles.ts
│   ├── preload/preload.ts   `window.voice` (sandboxed: imports only electron; channel names written out)
│   ├── shared/ipc.ts        Window states, commands, audio messages, channels, boundary checks
│   └── renderer/            One page per window: overlay (pill, waveform, swirl, tips, bubbles), settings,
│                            welcome, audio (getUserMedia → captureWorklet; not used on macOS), context-debug
└── test/                    Vitest: the core (ported Swift suites), main-process modules against a fake helper, IPC
```

## Flow

`HotkeyMonitor` → `PushToTalkGesture` action → `DictationController`:

1. **start** (key-down; consent given in the welcome wizard, signed in, both permissions): phase `arming`, nothing shown.
   `MicrophoneCapture` starts the pre-prepared engine off the main thread and streams buffers
   into `AudioRecorder`; `CaretLocator` finds the caret; the keyboard's language is read once
   (`KeyboardLanguage`), for the overlay's badge and the transcription request. After `minimumHoldDuration` the phase
   becomes `listening` and the overlay appears at the caret (swirl until audio arrives, then the
   waveform pill). Releasing earlier discards everything unseen.
2. **finish**: the mic keeps recording `releaseTailDuration`, then stops. No audio, or an empty
   transcript, shows "Didn't catch that". Otherwise the WAV is uploaded via
   `TranscriptionClient` (one forced-refresh retry on 401). The transcript and the screen context
   read at key-down (`ScreenContextProbe`) go to the backend cleanup prompt via
   `CompletionsClient` (same retry), and `TextInserter` pastes the cleaned text into the
   frontmost app and restores the clipboard. If the cleanup fails for any reason, the transcript
   is pasted as heard (`DictationCleanup.cleanUp`).
3. **cancel** (another key pressed during the hold): recording or upload is discarded; nothing
   is inserted.

A `generation` counter makes callbacks from a superseded dictation no-ops.

**Hands-free** (a tap, then a press within `doubleTapWindow`; ADR-DESK-021): the overlay shows at
once and the dictation goes on without the key until the hotkey is tapped again (finish) or Escape
(cancel); Space still switches the mode. **Tips** (`DictationTip`, under the listening pill): the Space
tip as a hold starts listening, the double-tap tip once a hold passes 20 s; each shows until learned
or shown its maximum number of times (`TipBook`, UserDefaults). The hands-free tip ("tap the hotkey to
finish, or Escape to cancel") shows once the second press is released as a tap and stays up while
listening, over the pill when the overlay opened above the caret's line; it is never learned.

**Agent mode** (Space pressed during the hold, again to switch back; ADR-DESK-011): the same
recording and transcription, with the tool bubbles in a row above the pill: Edit when text is selected,
Compose when not, plus Thunderbird when an email app is set up. The transcript is a request:
`DesktopAgent.tool` picks the tool (asking the backend's `system_prompt_desktop_agent` only whether
it goes to the email app), the phase becomes `running(tool)` (that bubble's border circles), and
`DesktopAgent.write` has the tool's prompt write the text. Edit pastes over the selection; Compose
pastes at the caret. A failure shows a message and pastes nothing. No agent call has a deadline.

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: macos`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Debug mode" switch, shown only to allowed accounts (ADR-DESK-018): it sends
dictation to dev.tabmail.ai and shows the menu's Start Dictation and debug items.
