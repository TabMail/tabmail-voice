## ADR-DESK-022: The Answer tool, the chat window, and agent tools switched on and off

> ⚠️ **Amended by ADR-DESK-036 (owner 2026-09-28):** the chat window no longer replaces the pill or
> opens at the caret's line (`chatFrame`, `chatOpensUpward`): it opens over the pill, which stays
> where it was with its bubbles (under them only without room over them), and rests there as a small
> circle between follow-ups. The status pill inside the window is gone.

**Context:** Owner, 2026-09-26: agent mode gains an Answer tool whose reply is shown, not pasted, in a
chat window that grows from the pill. With the window open, the hotkey starts a follow-up, "always in
agent mode". Escape or the window's X closes it; untouched it closes after 30 seconds, "like iOS
undo", with a bar showing the time left; a hover, click or scroll ends that timeout for good ("the
30-second thing is when there's no behavior"), and a click elsewhere does not close it. The owner also
asked that the availability of each tool be sent to the backend, "because the tool JSON definitions
live in the backend", and that every tool be in the welcome wizard and Settings, "toggleable, on by
default". First built in the Swift app; built here in the Electron app (ADR-DESK-032), which is the
one that ships.

**Decision:**
- `src/core/agent/tools.ts`: `AnswerTool` (`answer`); its prompt `system_prompt_desktop_answer`
  (backend ADR-023 amendment) replies with text that `deliver` hands to `ToolContext.showAnswer`.
  Each tool carries a `settingsDescription` and a `chatCaption` (what it did with its text; none for
  Answer).
- The tools offered (`DesktopAgent.tools(context, enabled, emailAppAvailable)`): the selection's
  writing tool (Edit or Compose), Thunderbird while an email app is available, and Answer, each only
  while enabled. None → `AgentError("noToolEnabled")`, with no completions call; one → it runs,
  with no choice call; more → the choice request lists them in `available_tools`
  (`CompletionsClient.complete`), and a reply naming a tool not offered is `noTool`. The agent's pick
  of the other writing tool is no longer overruled: that tool is not offered.
- `AppSettings` keeps the tools switched OFF (`disabledAgentTools`), so every tool, and every tool
  added later, is on until the user turns it off. `DictationSettings.enabledTools` is part of the
  key-down snapshot (ADR-DESK-017). Settings' Agent mode section and the wizard's Features step show
  one switch per tool, with its icon and `settingsDescription` (`setAgentToolEnabled`).
- `src/core/agent/chat.ts`: `AgentChat` (in memory only, gone when the window closes; root
  ADR-004) holds the turns: the request, the tool and its reply (an answer, or the text another tool
  pasted or sent). A follow-up sends `chatTranscript` to every prompt as `conversation`
  (`User: …` / `TabMail[ [caption]]: …`), so "why?" or "shorter" refers to the last reply. A
  follow-up another tool carries out is added to the chat with its caption. `formattedReply` renders
  inline Markdown only; a link that is not a web page's (`opensLink`) shows as plain text, as a reply
  carries the words on screen.
- `DictationController.chat` is the window's state (`onChatChange` on open and close). An answer
  opens it (`closesAt` = now + `chatTimeout`); `keepChatOpen()` (a hover, click or scroll in the
  window, or a follow-up) clears the timeout, and does nothing once it has closed; `closeChat()`
  (Escape, X, or the timeout) drops the conversation and discards a follow-up under way, or the
  failure a follow-up left showing. With the chat open, `start()` is a follow-up:
  agent mode from the start, Space switches nothing, no tips.
- `PushToTalkGesture.isChatOpen` in the `voice-hotkey` helper (the `setChatOpen` request, sent on
  every open and close and again when the helper restarts): Escape is kept from the app and closes
  the window (the `closeChat` action), during a follow-up too, held or hands-free, which closing it
  cancels; a held follow-up's key-up then does nothing. The helper handles each request in its own
  task, so two sent together can be applied in either order (found in review: an open and a close
  together left Escape kept after the window closed); the main process sends the hotkey's state
  (`configure`, `setChatOpen`) one request at a time, each after the last is answered, so the helper
  ends in the state sent last. A failed request holds up none after it.
- The conversation belongs to the account it was held under: `AccountModel.onAccountChange`
  (sign-out, or another account signing in, not a refreshed token) ends it and any agent request
  under way before the next account can send anything. A dictation under way goes on and is pasted
  as heard, without the cleanup (ADR-DESK-008).
- Nothing that finishes late writes to a newer chat: every step of a request checks its generation
  after each await, the answer and the delivery too, and the chat window drops a caret lookup still
  under way when it opens, so it stays where it opened.
- `OverlayWindowController.update(phase, chatOpen)`: the overlay window shows the chat window
  instead of the pill while the chat is open, takes the mouse only then (`setIgnoreMouseEvents`), and
  fits the height the page measures (`chatHeight`, at most `chatMaxHeight`, then it scrolls to the
  newest turn when a turn, the request under way or the follow-up's status changes, and not for a
  push that shows nothing new, so an earlier answer the user scrolled up to stays put), so only
  the shadow's margin around it catches clicks. It opens where the pill was (`chatFrame`), below the caret's line,
  or above it when the tallest window would not fit below (`chatOpensUpward`), and stays there for
  follow-ups. The window accepts the first click (`acceptFirstMouse`) without taking focus. The page
  sends `keepChatOpen` on pointer enter, move, down and wheel. A link opens through the main process
  (`openChatLink`), which checks it again and opens it only while the chat is open.

**Consequences:**
- The backend's ADR-023 amendment deploys before this build: an older backend ignores
  `available_tools` and has no answer prompt.
- Closing the chat while a follow-up is running cancels it before its next step: nothing more
  reaches the app, but a Thunderbird request closed between its paste and its Return is left typed,
  unsent, in TabMail's chat (the relay's cancellation, as before).
- The conversation is sent in full with every follow-up (no truncation); a very long one ends in a
  backend context-length error for that follow-up.
- Whether hover and the first click reach the never-focused overlay window on macOS is checked by
  hand; the tests drive the page's events and the window's calls.

**Amendment 2026-10-18 — memory (ADR-DESK-061).** `AgentChat` is still the window's conversation, in
memory only and gone when the window closes. Each agent-mode request and what came of it is now also
kept in memory on this computer (ADR-DESK-061), which the agent can search in later requests. The
Answer tool's Settings description no longer says the follow-up's earlier requests "aren't stored".


**Amendment 2026-10-25 — a click elsewhere closes the idle chat window (issue #250).** Owner,
2026-10-25: an option to close the chat window "when I click somewhere else or the focus of the app
changes", in Settings › Agent mode, on by default, and only "when it's idle", "not while it's
listening, or thinking". This replaces "a click elsewhere does not close it" above.
- `AppSettings.closesChatElsewhere` (stored `closesChatElsewhere`, default true), the switch "Close
  the chat when I click elsewhere" in Settings › Agent mode (`setClosesChatElsewhere`). It is read
  as each click or switch arrives, which is that close's whole operation.
- The overlay is never focused, so it has no blur to watch. While the chat window is open
  (`setChatOpen`), `voice-hotkey` tells the app `chatMouseDown` (a mouse button went down anywhere)
  and `chatFocusChanged` (another app or window came to the front), and stops when it closes.
  macOS: a second event tap, listen-only so no click is ever held back, and
  `NSWorkspace.didActivateApplicationNotification`. Windows: `WH_MOUSE_LL` and a
  `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` hook, out of context, on the hook thread, which only
  post to the writer thread. Linux: the GNOME extension sends `chatFocusChanged` over its `Action`
  signal when the focus window changes while the chat is wanted, which `GnomeControls` forwards;
  the Shell does not see clicks on app windows, so a click inside the window that already has the
  focus does not close it there. The signal is additive: the extension's `Version` stays 3, and a
  Shell still running the older extension until the next login just never sends it.
- The main process drops a `chatMouseDown` while the overlay takes clicks
  (`OverlayWindowController.isTakingClicks`): the pointer is over the chat window or its bubbles, so
  the click is theirs. Otherwise either event calls `DictationController.dismissChat()` when the
  switch is on, which closes the window as Escape does only while the phase is resting
  (`isResting`): a follow-up listening or being transcribed, a request running, and a tool's
  question waiting for its answer (asked while the request runs) all keep it open.
- A link clicked in the chat window opens a browser, which comes to the front and so closes the
  idle window, as any other app switch does.
