# TabMail Desktop — Claude Code Rules

The root `CLAUDE.md` rules apply in full. Desktop-specific additions:

- **Build and test:** `./Scripts/xcodegen.sh` after any `project.yml` or file add/remove, then
  `xcodebuild -project TabMailDesktop.xcodeproj -scheme TabMailDesktop -derivedDataPath DerivedData test`.
  `Secrets.xcconfig` (gitignored, from `Secrets.xcconfig.example`) must exist; add
  `CODE_SIGN_IDENTITY=-` when its `DEVELOPMENT_TEAM` is unset. Warnings are errors
  (`SWIFT_TREAT_WARNINGS_AS_ERRORS`); the App Intents "Metadata extraction skipped" line is the
  only tolerated diagnostic.
- **Never log transcript text, audio or tokens.** Dictation is user content. Log lengths, states
  and error types only, via `Log` (debug-gated).
- **Tests never hit the network.** Inject `HTTPTransport` (`StubTransport` in `TestSupport.swift`)
  and `InMemorySessionStore`; never the real Keychain item.
- **Every tunable number goes in `DictationConfig`.**
- **Release the microphone after every dictation.** `MicrophoneCapture` is per-session; never keep
  the engine running between holds (iOS memory 086 is the cautionary tale).
- **Tests never touch the user's clipboard or post keystrokes.** Use a uniquely named
  `NSPasteboard` and inject `pasteKeystroke` (see `TextInserterTests`).
- The unit-test bundle is hosted in the app; `AppDelegate` skips wiring when
  `XCTestConfigurationFilePath` is set, so tests raise no permission prompts.
