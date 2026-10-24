## ADR-DESK-013: One repository for TabMail Voice on every platform, one folder per platform

> ⚠️ **Amended by ADR-DESK-032 (owner 2026-09-27):** the platforms share one Electron app, `apps/desktop/`, not a native app each; `apps/macos/` was deleted at cutover (2026-09-27), with `Scripts/copy-worktree-secrets.sh` and the signing-config template.

**Context:** Owner, 2026-09-25: the repository will be renamed `tabmail-voice` on GitHub, with the
macOS app in a folder of its own so that other platforms (Windows, Linux) can follow. The layout
follows the OpenClaw reference (`references/openclaw/apps/{macos,ios,android,shared}`): each
platform is a native app in `apps/<platform>/`, and shared code is a package in `apps/shared/`
used only by apps in the same language (there, Swift for the Apple apps; Android is separate
Kotlin).

**Decision:** The macOS app, its XcodeGen spec and `xcodegen.sh` live in `apps/macos/`. Repository-wide
files stay at the root: the docs, `Scripts/copy-worktree-secrets.sh`, `Scripts/stt-compare/` (backend
speech-to-text comparison, platform-free), and the gitignored signing config with its template.
The signing config stays at the root so the worktree helper and every existing checkout keep
their copy where it is; `project.yml` reads it as `../../`.

**Consequences:**
- Commands run from the repository root with `apps/macos/` paths; each worktree's DerivedData is
  `apps/macos/DerivedData`.
- No shared package yet. Most of the app is platform-specific (hotkey, microphone, Accessibility
  reading, paste, overlay), and the intelligence (transcription, cleanup, agent prompts) is on the
  backend, which is already shared. When a second app needs the platform-free parts (gesture
  recognizer, dictation and agent flow, backend clients, WAV encoding), they move into
  `apps/shared/` as a Swift package, if that app is Swift; otherwise the second app shares the
  backend contract and test vectors, not code.
- The GitHub rename and the local folder rename (`tabmail-macos` → `tabmail-voice`) are separate
  steps, after the open branches merge. Done 2026-09-26 at the owner's request, before they merged:
  `TabMail/tabmail-voice` on GitHub (the old URL redirects), the primary checkout at
  `tabmail-voice/`, worktrees re-attached with `git worktree repair`.

