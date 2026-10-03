# TabMail Voice — Claude Code Rules

The root `CLAUDE.md` rules apply in full. TabMail Voice additions:

- **Layout:** the app is `apps/desktop/`, one Electron app for macOS, Windows and Linux
  (ADR-DESK-032; the Swift app it replaced was removed at cutover, and its last source is in git
  history). Repository-wide files (docs, `Scripts/stt-compare/`) stay at the root.
- **`apps/desktop/`:** TypeScript only; `src/core` stays free of Node and Electron; OS work goes in
  a native helper (`native/<os>`), not a Node addon, and the dictation path (microphone, hotkey,
  paste) stays native on every platform. Check it from `apps/desktop/` with `npm test`,
  `npm run typecheck`, `npm run lint` and `./scripts/swift-errors.sh test` (the macOS helpers);
  `node scripts/build-native.mts` builds the helpers. A fresh worktree needs
  `npx -y npm@11.19.1 install` first. Warnings are errors (`eslint --max-warnings 0`, and the
  Swift helpers build clean).
- **Don't launch the app from a session** unless the owner asks: it reads the sign-in from the
  Keychain, which can raise a prompt on the owner's screen. `npm run preview` renders the overlay,
  Settings and welcome windows offscreen to check the UI.
- **User content goes to the debug log file only, through `log.content`** (ADR-DESK-015):
  transcripts, the screen read, every backend request and its raw reply, the text pasted.
  `log.debug`/`log.error` carry lengths, states and error types only, and `log.error` reaches
  stderr in every build. Never log audio or an access token (`BackendLog` masks `Authorization`).
  Debug builds, and a release build while debug mode is on, write
  `~/Library/Logs/TabMail Voice/TabMail Voice.log`, the place to read a manual test's app log.
- **Tests never hit the network.** Inject `StubTransport` and `InMemorySessionStore`
  (`test/support/stubs.ts`); never the real Keychain item.
- **A connector is one file in `src/core/agent/connectors/`, declared with `defineConnector`.**
  `registry.ts` there is AUTO-GENERATED (`npm run gen:registries`, run before build, typecheck and
  test): never edit it by hand (ADR-DESK-044).
- **What looks like a secret is defined once, in `apps/desktop/native/shared/privacy/redactors.json`**
  (ADR-DESK-046). Every helper's list is AUTO-GENERATED from it (`npm run gen:redactors`): never edit
  a `Redactors.generated.*` file or copy a pattern into a helper by hand, and add a case to
  `redaction-cases.json` with every pattern. What must not be read (password fields, excluded apps
  and websites, secret-looking text) is refused or removed in the helper, never in the Electron app;
  a rule the app and the helpers both apply (which hosts a site covers) has its cases in
  `native/shared/privacy/` and every side runs them.
- **Every tunable number goes in `src/core/config.ts`** (the helpers' in their `HelperConfig`), and
  **every color in `src/core/palette.ts`** (ADR-DESK-048).
- **Release the microphone after every dictation.** `MicrophoneCapture` in `voice-microphone` is
  per-session; never keep the engine running between holds (iOS memory 086 is the cautionary
  tale). That helper runs one engine: it ends itself after each dictation, a failed start or an
  input change, and the app starts it afresh (ADR-DESK-032). Never run a second engine in the
  process or release one there.
- **Names follow `PROJECT_STRUCTURE.md` › Naming** (files, helpers, targets, wire methods,
  config): match it, and add to it when a new kind of thing gets a name.
- **No internal mistake IDs (`MIS-…`) in this public repo** (owner, 2026-09-28): they point into
  the private monorepo's log, which no reader here can open. Say the lesson in place instead.
- **Tests never touch the user's clipboard or post keystrokes.** Use a uniquely named
  `NSPasteboard` and inject `pasteKeystroke` (see `TextInserterTests`).
