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
Every file, folder and what it holds: [the file tree](Companion/Memory/Current/001-desktop-file-tree.md).

```
apps/desktop/
├── resources/           Icons, tray images, DMG background, entitlements; Linux apt source and keys (ADR-DESK-058); Windows installer.nsh, the VC++ runtime (ADR-DESK-057)
├── scripts/             build-native (macOS SwiftPM, Windows CMake), memory-helper (ADR-DESK-061), home-folder, gen-registries, swift-errors.sh, preview/
├── native/shared/       rust/ (the ONE home of logic the helpers share, ADR-DESK-054), context/, microphone/, privacy/ (redactors.json, ADR-DESK-046/047): cases every helper runs
├── native/memory/       native-fts.json, the tabmail-native-fts commit `voice-memory` is built from (ADR-DESK-061)
├── native/macos/        SwiftPM helpers voice-hotkey, voice-macos, voice-microphone, voice-screen-reader, voice-field-reader (ADR-DESK-044)
├── native/windows/      CMake/MSVC helpers (Win32 hotkey, UI Automation and paste, WASAPI, the screen read)
├── src/core/            Platform-free logic: config, palette, log, settings; agent/ (flat toolRegistry, tool definitions, connectors/, ADR-DESK-011), dictation/, audio/, backend/, dictionary/, memory/, hotkey/, onboarding/, ui/, util/
├── src/main/            Main process: index.ts, audioCapture, windows and tray, documents/ (ADR-DESK-051), updater (ADR-DESK-041/050), native/ (helper clients; macos/, windows/, linux/), storage/
├── src/preload/, src/shared/ipc.ts, src/renderer/ (one folder per window: overlay, settings, welcome, history, contextDebug)
└── test/                Vitest, mirroring src/; support/ (stubs, fakes)
```

## Naming

What a new file, target or name must match (the folders' rules are ADR-DESK-044's):

| What | Convention | Examples |
|---|---|---|
| TypeScript files and folders | camelCase; an entry point is `index`; no file repeats its folder's name; a platform's own code in a `macos/` or `windows/` folder | `audioCapture.ts`, `native/helperClient.ts`, `agent/chat.ts`, `native/macos/system.ts` |
| TypeScript tests | The module's name and folder under `test/`, ending `.test.ts`; shared stand-ins in `test/support/` | `test/main/audioCapture.test.ts`, `test/support/fakeHelper.mjs` |
| Scripts | kebab-case `.mts` (Node runs them directly); a platform's in its folder | `scripts/build-native.mts`, `scripts/macos/build-native.mts` |
| TypeScript names | Types, classes and React components PascalCase; functions, variables and every constant camelCase (no `SCREAMING_CASE`, `config.ts` included); an error class ends `Error`; a number in `config.ts` says its unit in its comment, and is milliseconds where it is a time | `SessionAudioCapture`, `MicrophoneError`, `microphoneStartTimeout` |
| Helper executables | kebab-case, `voice-<what>` (`.exe` on Windows); the name is also the helper's name in the log; one built from another repository is renamed so (`voice-memory`, Thunderbird's `fts_helper`) | `voice-hotkey`, `voice-macos`, `voice-microphone`, `voice-screen-reader`, `voice-field-reader`, `voice-memory`, `voice-windows.exe`, `voice-microphone.exe` |
| Swift targets | PascalCase: `Voice<What>` (the executable, only its `main.swift`) over `Voice<What>Kit` (the library), tested by `Voice<What>KitTests` | `VoiceMicrophone`, `VoiceMicrophoneKit`, `VoiceMicrophoneKitTests` |
| Swift files | PascalCase, named for the type declared; a test file is that type's name plus `Tests`, in the same folder under `Tests/`; a kit's requests are its `<What>Service` (an enum with `register(on:)`), its tunable numbers its `HelperConfig` | `MicrophoneCapture.swift`, `MicrophoneCaptureTests.swift`, `MicrophoneService`, `HelperConfig.swift` |
| Swift names | Types PascalCase; functions, properties, constants and enum cases camelCase; a dispatch queue's label is `ai.tabmail.voice.helper.<camelCase>` | `restartExitCode`, `ai.tabmail.voice.helper.microphoneChunks` |
| Windows helper sources | snake_case `.h`/`.cpp`; types PascalCase, functions and variables camelCase, in namespace `voice` | `helper_config.h`, `screen_context.h`, `voice::Microphone` |
| The helpers' wire | Methods, events and their fields camelCase, a concern's methods sharing its prefix; the same names on every platform that has them | `microphoneStart`, `microphoneChunk`, `sampleRate` |
| Decisions | `ADR-DESK-NNN`, the next number; a change to one is a dated **Amendment** under it, never a rewrite | `ADR-DESK-032`, "Amendment 2026-10-01" |

## Flow

`voice-hotkey` sends each gesture action to `DictationController` (`src/core/dictation/controller.ts`):
start (arming, the microphone, caret, keyboard language and target app, ADR-DESK-042), finish
(transcribe and clean up in one backend request, paste through `TextInserter` with the clipboard put
back by `ClipboardKeeper`, ADR-DESK-002; `notPasted` when the captured window cannot be restored; chunked long
dictations, ADR-DESK-049), cancel, the `generation` counter, hands-free and the triple tap
(ADR-DESK-021, ADR-DESK-043), tips, and agent mode (`DesktopAgent.run`, the bubbles and the chat
window, ADR-DESK-011/033/036/055): [the dictation flow](Companion/Memory/Current/002-dictation-flow.md).

## Relationships

Talks to the TabMail backend (`/dictation/transcribe`, `X-Client-Type: voice`) with a Supabase
JWT from `auth.tabmail.ai`. Settings has a "Debug mode" switch, shown only to allowed accounts (ADR-DESK-018): it sends
dictation to dev.tabmail.ai and shows the menu's Start Dictation and debug items.
Packaged macOS (universal, Apple silicon and Intel; each Mac app reads the feed of the architecture it runs as) and Windows builds update themselves from `cdn.tabmail.ai/releases/voice/<os>-<arch>/`
(`latest-mac.yml`, `latest.yml` on Windows) with `electron-updater`, sending no installation ID (ADR-DESK-041,
ADR-DESK-050). On Linux apt updates the package from the signed repository at `cdn.tabmail.ai/releases/voice`,
whose source and keys the package installs (ADR-DESK-058).

Captured-window identities, helper methods and GNOME integration: [the target-window flow](Companion/Memory/Current/003-captured-windows.md).

Private screen-source transport: `caretSelectionOnly` follows an approved non-field caret source
through native reservation and shared Rust finalization, where only its selected part is shown.
Windows `native/windows/src/page_selection.h` admits that source domain before any text read;
`tests/page-selection.cpp` pins its metadata and projection effects without an OS provider.
