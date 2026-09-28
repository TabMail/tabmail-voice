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
├── resources/               App icon, tray template images, macOS entitlements (electron-builder's buildResources)
├── scripts/
│   ├── build-native.mts         Builds the platform's helpers into dist/helpers (macOS: SwiftPM, arm64)
│   ├── swift-errors.sh          Runs a SwiftPM command in native/macos, printing only diagnostics and summaries
│   └── preview/                 `npm run preview`: renders the overlay, Settings and welcome windows with sample states offscreen, saved as PNGs
├── native/macos/            SwiftPM package: the macOS helpers and their tests
│   ├── Sources/VoiceHelperSupport/  The line protocol (requests, replies, events, debug-gated stderr)
│   ├── Sources/VoiceHotkeyKit/      Event tap + push-to-talk gesture (`voice-hotkey`)
│   └── Sources/VoiceMacOSKit/       Paste/restore, screen read, caret, keyboard language, Globe, activator, email apps, Thunderbird, the microphone (`voice-macos`)
├── src/
│   ├── core/                Platform-free logic (DOM lib only; no Node/Electron), ported from the Swift app
│   │   ├── dictationController.ts   The dictation state machine; settings snapshotted at key-down
│   │   ├── account.ts, backend.ts, cleanup.ts, http.ts   Sign-in, transcription/completions clients, cleanup
│   │   ├── agent/                   DesktopAgent, the tools, EmailClient, ThunderbirdRelay
│   │   ├── audio.ts, levelEnvelope.ts, wav.ts   Recording, waveform level, WAV
│   │   ├── settings.ts, permissions.ts, tips.ts, welcomeWizard.ts, globeKeyAction.ts, screenContext.ts
│   │   ├── overlayGeometry.ts, menuModel.ts   Where the overlay sits; what the tray menu shows
│   │   └── config.ts, log.ts, observable.ts, keyValueStore.ts, timeout.ts, text.ts, hotkey.ts
│   ├── main/                The main process (Node + Electron)
│   │   ├── main.ts                  Wires everything: helpers, controller, windows, IPC, tray
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

`voice-hotkey` (`HotkeyMonitor` → `PushToTalkGesture`) sends each gesture action to the main
process, which hands it to `DictationController` (`src/core/dictationController.ts`):

1. **start** (key-down; consent given in the welcome wizard, signed in, both permissions): phase `arming`, nothing shown.
   The microphone starts (`SessionAudioCapture` → `voice-macos`'s `MicrophoneCapture`, its engine
   prepared ahead) and streams samples into `AudioRecorder`; `voice-macos` finds the caret; the
   keyboard's language is read once, for the overlay's badge and the transcription request. After
   `minimumHoldDuration` the phase becomes `listening` and the overlay appears at the caret (swirl
   until audio arrives, then the waveform pill). Releasing earlier discards everything unseen.
2. **finish**: the mic keeps recording `releaseTailDuration`, then stops. No audio, or an empty
   transcript, shows "Didn't catch that". Otherwise the WAV is uploaded via
   `TranscriptionClient` (one forced-refresh retry on 401). The transcript and the screen context
   read at key-down (`ScreenContextProbe`) go to the backend cleanup prompt via
   `CompletionsClient` (same retry), and `voice-macos` pastes the cleaned text into the
   frontmost app and restores the clipboard (`TextInserter`). If the cleanup fails for any reason,
   the transcript is pasted as heard (`DictationCleanup`).
3. **cancel** (another key pressed during the hold): recording or upload is discarded; nothing
   is inserted.

A `generation` counter makes callbacks from a superseded dictation no-ops.

**Hands-free** (a tap, then a press within `doubleTapWindow`; ADR-DESK-021): the overlay shows at
once and the dictation goes on without the key until the hotkey is tapped again (finish) or Escape
(cancel); Space still switches the mode. **Tips** (`DictationTip`, under the listening pill): the Space
tip as a hold starts listening, the double-tap tip once a hold passes 20 s; each shows until learned
or shown its maximum number of times (`TipBook`, kept in the settings file). The hands-free tip ("tap the hotkey to
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
