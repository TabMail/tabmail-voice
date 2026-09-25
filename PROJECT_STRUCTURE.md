# TabMail Desktop — Project Structure

macOS menu-bar dictation app: hold a key, speak, and the text is typed into whatever field has
focus. Speech is transcribed by the TabMail backend (`POST /dictation/transcribe` → OpenRouter).
Swift 6 / SwiftUI + AppKit, macOS 15+, XcodeGen.

```
tabmail-macos/
├── project.yml                 XcodeGen spec (app + unit tests). Generate via Scripts/xcodegen.sh
├── Secrets.xcconfig.example    → copy to gitignored Secrets.xcconfig (DEVELOPMENT_TEAM); loaded via configFiles
├── Scripts/xcodegen.sh         Generates TabMailDesktop.xcodeproj with the signing team injected
├── TabMailDesktop/
│   ├── App/
│   │   ├── TabMailDesktopApp.swift   @main: MenuBarExtra + Settings scenes; AppDelegate wires everything
│   │   └── AppSettings.swift         Hotkey choice (UserDefaults), open-at-login (SMAppService)
│   ├── Account/
│   │   ├── AccountModel.swift        Signed-in session; single-flight token refresh (refresh tokens are single-use)
│   │   ├── AuthClient.swift          Supabase email one-time-code sign-in + refresh; injectable HTTPTransport
│   │   ├── SessionStore.swift        Keychain session storage (SessionStoring protocol)
│   │   └── TabMailSession.swift      GoTrue session wire model (same shape as iOS)
│   ├── Backend/
│   │   ├── BackendError.swift        Backend HTTP error → user message
│   │   ├── TranscriptionClient.swift POST /dictation/transcribe
│   │   └── CompletionsClient.swift   POST /completions/chat with one named backend prompt; reply from the SSE `final` event (as iOS)
│   ├── Config/DictationConfig.swift  Every tunable number and endpoint (timings, audio, backend, auth, overlay)
│   ├── Context/                  Screen context read at key-down, for the transcript cleanup
│   │   ├── ScreenContext.swift       App, host, terminal program, caret text, visible text blocks in reading order
│   │   ├── ScreenContextReader.swift Accessibility walk of the focused window; tmux pane for terminals
│   │   └── ScreenContextProbe.swift  Captures at key-down in the background; the cleanup awaits it; latest kept for the debug window
│   ├── Dictation/
│   │   ├── DictationController.swift State machine idle → arming → listening → transcribing → idle/failed; 401 retry
│   │   ├── DictationCleanup.swift    The cleanup prompt's variables: transcript + screen context
│   │   ├── MicrophoneCapture.swift   System default mic; engine pre-prepared (mic off), started per dictation on a serial queue
│   │   ├── AudioRecorder.swift       Converts to 16 kHz mono Int16, accumulates, tracks peak, caps duration
│   │   ├── LevelEnvelope.swift       Waveform level adapted to the incoming range (EMA floor/peak envelopes)
│   │   └── WAVEncoder.swift          44-byte RIFF header around the PCM
│   ├── Hotkey/
│   │   ├── PushToTalkGesture.swift   Pure recogniser: press → start, release → finish, chord → cancel
│   │   └── HotkeyMonitor.swift       NSEvent global + local monitors feeding the gesture
│   ├── Insertion/
│   │   ├── TextInserter.swift        Paste-and-restore insertion; PasteboardSnapshot
│   │   ├── CaretLocator.swift        Caret (else focused field) rect via Accessibility (anchors the overlay)
│   │   └── AccessibilityActivator.swift  Asks Gecko/Electron apps to build their tree as they come to the front
│   ├── Permissions/PermissionsModel.swift  Microphone + Accessibility status, prompts, grant polling
│   ├── Support/Log.swift             Debug-gated os.Logger (never logs transcript content)
│   └── UI/
│       ├── MenuContent.swift         Menu-bar menu
│       ├── SettingsView.swift        Settings window
│       ├── ScreenContextDebugView.swift  Debug builds: "Show Last Screen Context" window
│       └── OverlayPanel.swift        Non-activating overlay at the caret: warm-up swirl → voice waveform pill → spinning circle while transcribing
│   └── Resources/Assets.xcassets     AppIcon (from the iOS icon) + MenuBarIcon template glyph
└── TabMailDesktopTests/        Swift Testing suites (see TESTS.md)
```

## Flow

`HotkeyMonitor` → `PushToTalkGesture` action → `DictationController`:

1. **start** (key-down; signed in + both permissions): phase `arming`, nothing shown.
   `MicrophoneCapture` starts the pre-prepared engine off the main thread and streams buffers
   into `AudioRecorder`; `CaretLocator` finds the caret. After `minimumHoldDuration` the phase
   becomes `listening` and the overlay appears at the caret (swirl until audio arrives, then the
   waveform pill). Releasing earlier discards everything unseen.
2. **finish**: the mic keeps recording `releaseTailDuration`, then stops. No audio, or an empty
   transcript, shows "Didn't catch that". Otherwise the WAV is uploaded via
   `TranscriptionClient` (one forced-refresh retry on 401). The transcript and the screen context
   read at key-down (`ScreenContextProbe`) go to the backend cleanup prompt via
   `CompletionsClient` (same retry), and `TextInserter` pastes the cleaned text into the
   frontmost app and restores the clipboard.
3. **cancel** (another key pressed during the hold): recording or upload is discarded; nothing
   is inserted.

A `generation` counter makes callbacks from a superseded dictation no-ops.

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: macos`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Use development server" toggle (dev.tabmail.ai).
