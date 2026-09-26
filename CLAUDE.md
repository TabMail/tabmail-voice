# TabMail Voice — Claude Code Rules

The root `CLAUDE.md` rules apply in full. TabMail Voice additions:

- **Layout:** one folder per platform under `apps/` (ADR-DESK-013); the macOS app is `apps/macos/`.
  Repository-wide files (docs, the signing-config helper, `Scripts/stt-compare/`) stay at the root.
- **Build and test** (from the repository root): `./apps/macos/Scripts/xcodegen.sh` after any
  `project.yml` or file add/remove, then
  `xcodebuild -project apps/macos/TabMailVoice.xcodeproj -scheme TabMailVoice -derivedDataPath apps/macos/DerivedData test`.
  `Secrets.xcconfig` (gitignored, from `Secrets.xcconfig.example`) must exist at the repository
  root, where the worktree helper installs it; add
  `CODE_SIGN_IDENTITY=-` when its `DEVELOPMENT_TEAM` is unset. Warnings are errors
  (`SWIFT_TREAT_WARNINGS_AS_ERRORS`); the App Intents "Metadata extraction skipped" line is the
  only tolerated diagnostic.
- **User content goes to the debug log file only, through `Log.content`** (ADR-DESK-015):
  transcripts, the screen read, every backend request and its raw reply, the text pasted.
  `Log.debug`/`Log.error` also reach the unified log, so they carry lengths, states and error types
  only. Never log audio or an access token (`BackendLog` masks `Authorization`). Debug builds write
  `~/Library/Logs/TabMail Voice/TabMail Voice.log`, the place to read a manual test's app log.
- **Tests never hit the network.** Inject `HTTPTransport` (`StubTransport` in `TestSupport.swift`)
  and `InMemorySessionStore`; never the real Keychain item.
- **Every tunable number goes in `DictationConfig`.**
- **Release the microphone after every dictation.** `MicrophoneCapture` is per-session; never keep
  the engine running between holds (iOS memory 086 is the cautionary tale).
- **Tests never touch the user's clipboard or post keystrokes.** Use a uniquely named
  `NSPasteboard` and inject `pasteKeystroke` (see `TextInserterTests`).
- The unit-test bundle is hosted in the app; `AppDelegate` skips wiring when
  `XCTestConfigurationFilePath` is set, so tests raise no permission prompts.
