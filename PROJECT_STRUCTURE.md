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
        │   │   ├── AuthClient.swift          Supabase email one-time-code sign-in + refresh; injectable HTTPTransport
        │   │   ├── SessionStore.swift        Keychain session storage (SessionStoring protocol)
        │   │   └── TabMailSession.swift      GoTrue session wire model (same shape as iOS)
        │   ├── Agent/
        │   │   ├── DesktopAgent.swift        Agent mode: `AgentTool` (edit, compose, thunderbird); one call chooses the tool, one has it write the text
        │   │   ├── EmailClient.swift         The email app the Thunderbird tool drives: chosen in Settings, else the default email app if it is a Thunderbird
        │   │   └── ThunderbirdRelay.swift    Types a chat message into TabMail's chat in Thunderbird: front, ⌥⌘L, paste, Return, only while the chat has focus (spike)
        │   ├── Backend/
        │   │   ├── BackendError.swift        Backend HTTP error → user message
        │   │   ├── TranscriptionClient.swift POST /dictation/transcribe
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
        │   │   ├── LevelEnvelope.swift       Waveform level adapted to the incoming range (EMA floor/peak envelopes)
        │   │   └── WAVEncoder.swift          44-byte RIFF header around the PCM
        │   ├── Hotkey/
        │   │   ├── PushToTalkGesture.swift   Pure recogniser: press → start, release → finish, chord → cancel; Space during the hold → toggle agent mode
        │   │   └── HotkeyMonitor.swift       Keyboard CGEventTap feeding the gesture; keeps the mode-switching Space from the app in front
        │   ├── Insertion/
        │   │   ├── TextInserter.swift        Paste-and-restore insertion; PasteboardSnapshot
        │   │   ├── CaretLocator.swift        Caret (else focused field) rect via Accessibility (anchors the overlay)
        │   │   └── AccessibilityActivator.swift  Asks Gecko/Electron apps to build their tree as they come to the front
        │   ├── Onboarding/WelcomeWizard.swift  Welcome wizard steps and navigation (ADR-DESK-010): consent → permissions → features
        │   ├── Permissions/PermissionsModel.swift  Microphone + Accessibility status, prompts, grant polling, grant callbacks
        │   ├── Support/Log.swift             Debug-gated os.Logger (`debug`/`error` never carry transcript content); debug builds also append to ~/Library/Logs/TabMail Voice/TabMail Voice.log (`LogFile`, menu › Show Log File), where `Log.content` also writes user content in full (ADR-DESK-015)
        │   └── UI/
        │       ├── MenuContent.swift         Menu-bar menu
        │       ├── SettingsView.swift        Settings window
        │       ├── WelcomeView.swift         Welcome wizard: Thunderbird-style top rail, step pages, Back / Next
        │       ├── WelcomeWindowController.swift  Opens the wizard window (one at a time)
        │       ├── ScreenContextDebugView.swift  Debug builds: "Show Last Screen Context" window
        │       └── OverlayPanel.swift        Non-activating overlay at the caret: warm-up swirl → voice waveform pill → spinning circle while transcribing; a dark "space" keycap tooltip under the listening pill that fades after a moment; agent mode's icon-only tool bubbles in a row above it, the running one's border circling
        │   └── Resources/Assets.xcassets     AppIcon (from the iOS icon) + MenuBarIcon template glyph
        └── TabMailVoiceTests/          Swift Testing suites (see TESTS.md)
```

## Flow

`HotkeyMonitor` → `PushToTalkGesture` action → `DictationController`:

1. **start** (key-down; consent given in the welcome wizard, signed in, both permissions): phase `arming`, nothing shown.
   `MicrophoneCapture` starts the pre-prepared engine off the main thread and streams buffers
   into `AudioRecorder`; `CaretLocator` finds the caret. After `minimumHoldDuration` the phase
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

**Agent mode** (Space pressed during the hold, again to switch back; ADR-DESK-011): the same
recording and transcription, with the tool bubbles in a row above the pill: Edit when text is selected,
Compose when not, plus Thunderbird when an email app is set up. The transcript is a request:
`DesktopAgent.tool` picks the tool (asking the backend's `system_prompt_desktop_agent` only whether
it goes to the email app), the phase becomes `running(tool)` (that bubble's border circles), and
`DesktopAgent.write` has the tool's prompt write the text. Edit pastes over the selection; Compose
pastes at the caret. A failure shows a message and pastes nothing. No agent call has a deadline.

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: macos`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Use development server" toggle (dev.tabmail.ai).
