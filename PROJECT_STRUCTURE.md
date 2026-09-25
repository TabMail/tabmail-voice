# TabMail Desktop — Project Structure

macOS menu-bar dictation app: hold a key, speak, and the text is typed into whatever field has
focus. Speech is transcribed by the TabMail backend (`POST /dictation/transcribe` → OpenRouter).
Swift 6 / SwiftUI + AppKit, macOS 15+, XcodeGen.

```
tabmail-desktop/
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
│   ├── Backend/TranscriptionClient.swift  POST /dictation/transcribe; backend error → user message
│   ├── Config/DictationConfig.swift  Every tunable number and endpoint (timings, audio, backend, auth, overlay)
│   ├── Dictation/
│   │   ├── DictationController.swift State machine idle → arming → listening → transcribing → idle/failed; 401 retry
│   │   ├── MicrophoneCapture.swift   System default mic; engine pre-prepared (mic off), started per dictation on a serial queue
│   │   ├── AudioRecorder.swift       Converts to 16 kHz mono Int16, accumulates, tracks peak, caps duration
│   │   └── WAVEncoder.swift          44-byte RIFF header around the PCM
│   ├── Hotkey/
│   │   ├── PushToTalkGesture.swift   Pure recogniser: press → start, release → finish, chord → cancel
│   │   └── HotkeyMonitor.swift       NSEvent global + local monitors feeding the gesture
│   ├── Insertion/
│   │   ├── TextInserter.swift        Paste-and-restore insertion; PasteboardSnapshot
│   │   └── CaretLocator.swift        Focused field's caret rect via Accessibility (anchors the overlay)
│   ├── Permissions/PermissionsModel.swift  Microphone + Accessibility status, prompts, grant polling
│   ├── Support/Log.swift             Debug-gated os.Logger (never logs transcript content)
│   └── UI/
│       ├── MenuContent.swift         Menu-bar menu
│       ├── SettingsView.swift        Settings window
│       └── OverlayPanel.swift        Non-activating overlay at the caret: warm-up swirl → waveform pill
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
2. **finish**: the mic keeps recording `releaseTailDuration`, then stops. Recordings without
   enough speech show "too quiet" and aren't uploaded. Otherwise the WAV is uploaded via
   `TranscriptionClient` (one forced-refresh retry on 401), and `TextInserter` pastes the text
   into the frontmost app and restores the clipboard.
3. **cancel** (another key pressed during the hold): recording or upload is discarded; nothing
   is inserted.

A `generation` counter makes callbacks from a superseded dictation no-ops.

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: desktop`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Use development server" toggle (dev.tabmail.ai).
