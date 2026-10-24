## ADR-DESK-015: Debug builds log user content in full, to the local log file only

**Context:** Owner, 2026-09-26: an agent-mode reply came out of context, and nothing could say why.
The app logged lengths only, so what it had sent and received could not be read back. "We need more local observability. The raw responses and things that we send to the
backend … these logs are saved locally so we just want to be super detailed."

**Decision:** `Log.content(label, text)` writes a named block, whole, to the debug log file
(`~/Library/Logs/TabMail Voice/TabMail Voice.log`) and nowhere else: not the unified log, and
compiled out of Release builds. It carries:
- every backend request as sent (method, URL, headers, exact body), the prompt's variables one by
  one with their line breaks, and the raw reply (status, headers including `cf-ray`, whole body),
  also for an HTTP error (`BackendLog`, `CompletionsClient`, `TranscriptionClient`);
- the screen read at key-down: every field, the text around the caret, the visible text as the
  prompts get it (`ScreenContext.logDescription`);
- the transcript, the cleaned text, each agent tool's text, the text pasted and the chat message sent
  to Thunderbird.

Never logged: audio (the transcription request shows its size in its place) and the access token
(`Authorization` is masked). `Log.debug` and `Log.error` stay content-free.

**Consequences:**
- The debug log file on a developer's Mac holds screen text, mail and chat text. ADR-004 governs what
  the server keeps; this is a local file written only by builds from source.
- The file is capped at `logFileMaxBytes` (50 MB, was 5 MB), one earlier file kept: a dictation logs
  its screen read several times.
- A test sees the entries through the task-local `Log.contentObserver` (`ContentLogTests`, and the
  controller's paths in `DictationControllerTests`), which pins that the token and the audio stay
  out; the task-local `LogFile.destination` lets a test read an entry back from a file of its own.
- Builds from source are debug builds, so they keep this log too (README).
- *Amended 2026-09-30 (owner): a packaged (release) build writes the same log, content included,
  while debug mode is on, so a problem in the release build can be read back. Debug mode is offered
  only to the accounts `DebugAccess` allows, so no other user's build writes it. The log follows the
  switch and the account signed in as they change (`setDebugMode` in `core/log.ts`). The helpers now
  always send their `debug` lines and the app keeps them only while it logs. Keeping the last
  recording (audio) stays debug builds only.*

