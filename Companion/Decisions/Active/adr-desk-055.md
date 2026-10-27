## ADR-DESK-055: Agent mode is one tool loop; Compose and Edit end it by pasting

**Context:** Owner, 2026-10-05: agent mode chose Answer too often, and a request such as "check my
calendar and write when I'm free" needs a lookup, then text in the app, which the choose-then-write
split could not do in one request. The owner: all tools are equal, as in TabMail's Thunderbird and
iOS loops; the agent runs the calendar tool, then the compose tool, which pastes. Compose and Edit
are one tool, offered by whether text is selected, and the only way to paste; calling one ends the
request, closing the chat window if one is open, and whatever the agent writes beside the call is
ignored. A plain reply goes to the chat window. The owner first approved a breaking change, then asked
for it versioned instead: the app becomes 0.2.0, and the backend serves the loop only to 0.2.0 and
later, so earlier builds keep the chooser and the backend can ship first.

**Decision:**
- One backend prompt, `system_prompt_desktop_agent_loop` (backend ADR-023 amendment "one tool loop"),
  run by `DesktopAgent.run`. The backend versions it, and the `compose`/`edit` tools, at `v0.2.0`, and
  the app is 0.2.0 (`X-Client-Version`), which is what makes them resolve. Its `available_tools` (`DesktopAgent.loopTools`) are, with Answer on, the
  backend's date tools, its web search while the Web switch is on, `confirmation_answer` when an app is on, every connector's name, and
  the writing tool; with Answer off, the writing tool alone, and no app's tool runs even when the
  model calls one anyway (the backend passes on every call it makes, so the app is the only gate;
  found in review). The writing tool is Edit when text is
  selected, Compose when not (`DesktopAgent.writingTool`); the other is never offered.
- `compose` and `edit` take `{text}`: the agent writes the final text itself. A round that calls the
  offered writing tool ends the loop with that text (`DesktopAgent.written`, fitted to the selection
  for Edit); no other call of that round runs. A round's assistant text beside a call is never read
  (`CompletionsClient.round` prefers `tool_calls`). A call to a writing tool not offered is answered
  as a tool the app does not have.
- The controller closes the chat window (`dropChat`) before it pastes, so the window is gone before
  the text arrives. A reply opens or continues the chat window, as Answer did; with Answer off, a
  reply has nowhere to go and the request fails with "no text".
- An Edit of a selection the helper redacted (ADR-DESK-046) is refused when the agent writes it
  (`secretInSelection`), not before the loop: the selection is still the request's context.
- While the loop thinks no tool's bubble runs (`running` with no tool); the writing tool's runs once
  the agent writes, Answer's once it replies (amendment 2026-10-07).
- Removed: the chooser, the per-tool prompts (`agentEditPrompt`, `agentComposePrompt`,
  `agentThunderbirdPrompt`, `agentAnswerPrompt`), each `AgentTool`'s prompt and variables, and the
  `noTool` failure. The Thunderbird tool stays off (ADR-DESK-037); bringing it back is offering it as
  a loop tool, and its controller tests went with the chooser.

**Consequences:**
- Lookups and writing happen in one request; the bubbles still show one running tool at a time.
- Text planted on screen, or returned by a tool (a web page, a PDF, a note), could try to steer what the
  agent pastes, into any app, a terminal included. The owner accepts the risk (2026-10-05: "it is the
  risk we're gonna take"); the backend fences the context as content, not instructions, before and
  after it, and tells the model to ignore instructions in what tools return (backend ADR-023
  amendment).
- Builds before 0.2.0 keep the chooser; the backend carries both until no 0.1.x build is in use. This
  build needs the backend that carries the loop, so the backend deploys first.

**Amendment 2026-10-07 (owner, smoke test of 0.2.0):** a request that looked something up and then
wrote flashed Answer's bubble and the chat window, with the request in it, before pasting. The owner:
the chat window opens only when the agent has something to show the user, its reply or a tool's
question. So:
- The loop thinks under no bubble (`Phase` `running` with `tool: null`); an app's bubble runs while
  its tool does, and Answer's only once the agent replies.
- A tool opens the chat window only to ask its question (`runConnectorTool`); one that just runs
  shows nothing but its app's bubble, and its progress label shows only in a window already open (a
  follow-up's). This replaces ADR-DESK-023's "the chat window opens for the first tool".
- The working pill is an empty circle in agent mode as in dictation, its rim or arc circling, no
  icon; the sparkles stay only on the resting pill under the chat window (`agentRestingSymbolSize`,
  was `agentRunningSymbolSize`).

**Amendment 2026-10-09 (owner): the chat window always shows what is going on.** The owner: *"in
agent mode always show what's going on … even when the agent doesn't answer, just show the searching
the web or whatever thing, the tool that's running and the user request … it's better to show user
inputs being accepted there, and then as tools run, just showing what's going on."* So the chat
window opens as an agent request is heard, with the request in it and "Thinking" under it, then each
tool's progress label while it runs (a tool here, or the backend's, such as the web search). This
replaces the 2026-10-07 rule above that only a reply or a question opens it. Unchanged: a write
still closes the window before the text is pasted, a failed or canceled request closes a window
with nothing else in it, the loop thinks under no bubble, and Answer's bubble runs only once the
agent replies. The window opens inactive (`showInactive`), so the app the text goes to keeps focus.

**Amendment 2026-10-25 (owner): the whole window is a tool, `screen_read`.** The owner: *"for off
screen reading, for the agent, this should then be a tool, so that it's used only when agent thinks
it needs more context about what the user is talking about, eg, can you summarize, or can you write
a comment about this considering others. Otherwise we'd waste a lot of tokens?"* The request carries
what the window shows (`screen_text`); `screen_read` (no arguments) gives the model the whole window,
read after it (ADR-DESK-016, 2026-10-25). It runs on this computer, asks nothing (it only reads), and
says "Reading the whole window" in the chat window while it waits; it has no bubble. It is listed in
`available_tools` with the memory tools (`DesktopAgent.loopTools`), Answer on or off, whenever the
window was read and is not hidden, and only then: the backend offers Voice only the tools it lists.
It answers the window's text, the hidden note when the whole window is hidden for privacy (an
excluded page outside the view), or that the window could not be read. When to call it is in the
tool's description alone (backend `src/tools/voice/screen_read-v1.10.0.json`); no prompt names it,
so the protocol stays 1.10.0 and Voice 0.4.0, which never lists it, is never offered it. The backend
keeps its result out of `web_read`'s provenance (`NO_PROVENANCE_TOOLS`), as the screen text.


**Amendment 2026-10-26: writing and `screen_read` share the captured window.** Compose/Edit
restore the operation's captured target before pasting (ADR-DESK-042). The initial shown read and
`screen_read`'s whole read address that same window even when Voice or another window is now in
front (ADR-DESK-016). The chat continues to close before a write; clicking it is allowed to activate
Voice, whose next follow-up targets the preceding external window.


**Amendment 2026-10-26 (owner): a flat registry executes every tool.** One request-scoped
`ToolRegistry` holds the enabled tool definitions. Each definition declares its handler, bubble,
progress label and `terminal` behavior; the response definition also declares `response: true`.
`DesktopAgent.run` dispatches calls by name, appends nonterminal results for the next model round,
and stops after a terminal handler finishes. It has no Compose/Edit name checks and no separate
post-loop delivery path. Calls execute in their returned order: calls before the terminal call run,
and calls after it do not. This supersedes the earlier rule that a writing call skipped every other
call in its round. Edit and Compose close the chat and paste inside their handlers; Answer receives
normal assistant text through the same registry and keeps the conversation open for follow-ups.
Selection eligibility, redacted-selection refusal, enabled-tool and connector policy, confirmation
and cancellation checks still apply. The UI lifecycle is shared by local tools and registered
backend-tool events. `screen_read` now has its viewfinder bubble, normal running animation and hover
tooltip, as the other tools; the earlier no-bubble statement is superseded.

**Amendment 2026-10-19 (owner): a write beside other tools lets the loop finish.** With the knowledge
base's tools (ADR-DESK-063) the model can call `kb_add` and Compose in one round ("remember that and
write it"); the writing call ended the request and the fact was never kept. The owner chose: *let the
loop finish*, then paste. So a round calling the offered writing tool and nothing else still ends the
request at once, but one calling it beside other tools holds its text (checked as it comes, so a call
without text or an Edit of a redacted selection still fails before anything runs), runs the others,
and answers the writing call with `agentWritingHeld`; the loop goes on, a later writing call
replaces the held text, and when the loop ends (a reply, or a writing call alone) the held text is
pasted and any reply is not shown. The round limit ends the loop with a reply, which pastes the held
text too. On the flat tool registry the loop knows no tool by name: what it holds is a round's first
terminal call made beside non-terminal ones, checked by its tool's `check` (for Compose and Edit, the
text they would paste), and a round of terminal calls alone runs its first one. Rejected: running the round's other calls and ending at once (no extra round, but the model
never hears what its other calls did).
