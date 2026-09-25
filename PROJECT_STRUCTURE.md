# TabMail Desktop — Project Structure

macOS menu-bar dictation app: hold a key, speak, and the text is typed into whatever field has
focus. Speech is transcribed by the TabMail backend (`POST /dictation/transcribe` → OpenRouter).
Swift 6 / SwiftUI + AppKit, macOS 15+, XcodeGen.

```
tabmail-desktop/
├── project.yml                 XcodeGen spec (app + unit tests). Generate via Scripts/xcodegen.sh
├── LocalSigning.xcconfig.example  → copy to gitignored LocalSigning.xcconfig (DEVELOPMENT_TEAM)
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
│   │   ├── DictationController.swift State machine idle → listening → transcribing → idle/failed; 401 retry
│   │   ├── MicrophoneCapture.swift   AVAudioEngine tap, created and torn down per dictation
│   │   ├── AudioRecorder.swift       Converts to 16 kHz mono Int16, accumulates, tracks peak, caps duration
│   │   └── WAVEncoder.swift          44-byte RIFF header around the PCM
│   ├── Hotkey/
│   │   ├── PushToTalkGesture.swift   Pure recogniser: press → start, release → finish, chord → cancel
│   │   └── HotkeyMonitor.swift       NSEvent global + local monitors feeding the gesture
│   ├── Insertion/TextInserter.swift  Paste-and-restore insertion; PasteboardSnapshot
│   ├── Permissions/PermissionsModel.swift  Microphone + Accessibility status, prompts, grant polling
│   ├── Support/Log.swift             Debug-gated os.Logger (never logs transcript content)
│   └── UI/
│       ├── MenuContent.swift         Menu-bar menu
│       ├── SettingsView.swift        Settings window
│       └── OverlayPanel.swift        Non-activating floating pill: level meter + status
└── TabMailDesktopTests/        Swift Testing suites (see TESTS.md)
```

## Flow

`HotkeyMonitor` → `PushToTalkGesture` action → `DictationController`:

1. **start** (signed in + both permissions): `MicrophoneCapture` streams buffers into
   `AudioRecorder`.
2. **finish**: mic stops. Too-short holds and silent recordings are dropped. Otherwise the WAV is
   uploaded via `TranscriptionClient` (with one forced-refresh retry on 401), and `TextInserter`
   pastes the text into the frontmost app and restores the clipboard.
3. **cancel** (another key pressed during the hold): recording or upload is discarded; nothing
   is inserted.

A `generation` counter makes callbacks from a superseded dictation no-ops.

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: desktop`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Use development server" toggle (dev.tabmail.ai).
