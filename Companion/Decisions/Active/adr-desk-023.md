## ADR-DESK-023: The Answer tool's loop, with tools that run on this computer

> The loop is now agent mode's only call, and Compose and Edit are tools in it (ADR-DESK-055, 2026-10-05).

**Context:** Owner, 2026-09-26: agent mode gains tools that run on the user's computer (calendar,
reminders, contacts, file search, email prefill, notes, messages, shortcuts, web), "the tool JSON
definitions live in the backend", and "sending or creating anything, you should ask for confirmation
first". The backend gave the app its own `macos` platform, whose Answer prompt runs the
function-calling loop with the tools the app lists in `available_tools` (backend ADR-017
amendment), starting with its own date tools. ADR-DESK-011's "no client-side tools" held while the
app read Thunderbird's registry; it no longer does. First built in the Swift app; built here in the
Electron app (ADR-DESK-032), which is the one that ships.

**Decision:**
- The Answer prompt is a loop (`DesktopAgent.answer`); Edit, Compose and Thunderbird stay one call
  each, and the choice stays one call. Each round (`CompletionsClient.round`) sends tools on
  (`disable_tools: false`), `available_tools` = the backend's date tools
  (`config.answerServerTools`) plus every `ConnectorTool`'s name (`DesktopAgent.answerTools`), and, after
  the first round, the loop's `conversation_state`. A round either replies (the answer) or returns
  `tool_calls` (each an `id`, a function `name` and its `arguments` as a JSON string; anything else
  is `invalidResponse`) and the state.
- The state stays opaque JSON: the app appends one `role: tool` message per call to its
  `harmony_messages` (`content`, `tool_call_id`), sets `current_round` to the rounds it has run, and
  sends every other field back as it came (reasoning signatures included). The backend's round limit
  counts that `current_round`, as for the iOS app (`BackendClient.sendCompletionsWithToolsInternal`).
  State without a `harmony_messages` array is `invalidResponse`, and no tool runs. The request's
  `AbortSignal` is checked before each round and each call: a request canceled while a tool ran
  runs no later call and sends no further round.
- `ConnectorTool` (`src/core/agent/connectors/contract.ts`): a tool that runs on this computer: its backend function
  `name`, a `progressLabel`, a `confirmation(args)` question for one that sends or creates (null for
  a read), and `run(args)`. The controller takes them as `DictationDependencies.connectorTools`, which the
  main process builds (a tool reaches the OS through a native helper); the list is empty until the
  first connector (a later PR). The backend's server tools (the date tools) run on the backend.
- `DictationController.runLoopTool`: a call to a tool the app doesn't have, or with arguments that
  aren't a JSON object, runs nothing and tells the model why (`Error: …`), as does a tool that
  throws (its error's message). The chat window opens for the first tool (if the request was not a
  follow-up; since ADR-DESK-055's 2026-10-07 amendment, only for a tool's question), showing the request and the tool's `progressLabel` (`AgentChat.activity`) while it
  runs. A tool with a `confirmation` asks it in the window (`AgentChat.confirmation`, Cancel /
  Confirm, the `answerConfirmation` command) and runs only once confirmed; declined, the model
  reads `config.loopToolDeclined`. An answer that comes before the question has shown for
  `config.chatConfirmationMinimumDisplay` (half a second) is ignored: the second click of a
  double-click on one question's Confirm, or a click aimed at its card as the next question
  replaces it, would otherwise confirm a question the user never saw (found in review; a question
  id sent back with the answer would catch only the stale card). Closing the window or canceling
  the request declines the question at once (`teardown`, the one place a request ends) and drops
  the request: the round's request in flight is canceled, the round's later calls don't run, and
  nothing is left waiting for the answer. A tool still running for a request that ended clears
  nothing of a newer one's.
- The chat window's timeout starts when the first answer joins it, and only if the user has not
  touched it (`AgentChat.touched`, which the page reads too, so a touch counts before the timeout
  starts): a window a tool opened waits for the answer, and one touched while a tool ran stays
  open. Each window opens untouched, so one touched and closed leaves the next to
  time out. A request that fails, is canceled or ends with the account after a tool opened an empty
  window closes it (`teardown`): the pill says what failed, and the next hold dictates.
- The date tools are not a switch in Settings or the wizard: they read nothing of the user's and
  only make dates right. Each tool that runs on this computer adds its switch with its connector.

**Consequences:**
- The backend's `macos` platform (ADR-017 amendment) is deployed before this build: an older backend
  offers the Answer prompt no tools, and the answer is written without them.
- Server tools run inside a round and show no progress in the chat window (the whole stream is read,
  then parsed); a slow server tool (web search, later) would need the stream read as it arrives.
  *(Later (ADR-DESK-036): the stream is read as it arrives, and a server tool's start and end show.)*
- A request waiting on a confirmation holds agent mode: the hotkey starts nothing until the user
  confirms, declines or closes the window, or the question's time runs out (below).
- Each round has the completions request timeout of its own (`completionsRequestTimeout`); a tool's
  run has none. A confirmation had none at first.

**Amendment 2026-09-28: a question has 30 seconds.** Owner: "Confirmation should get a time limit of
30 seconds max, and it should show a timer ticking, similar to the undo toast that we have." (It came
up as an event confirmed after its time had passed.)
- A question left unanswered for `config.chatConfirmationTimeout` (30 seconds) is declined: the tool
  doesn't run, and the model reads `config.loopToolUnanswered` ("didn't confirm in time"), not the
  decline, so it can say why. A touch in the window doesn't stop the clock, as it does the window's
  own timeout: the limit is a maximum.
- `AgentChat.confirmationExpiresAt` says when; the card shows the time left as a thin bar along its
  bottom edge, the chat window's `TimeoutBar` (itself the iOS undo toast's), timed by the question's
  own timeout.
- Each question has its own clock, stopped by any answer (the user's, the window closing, the request
  ending), so one answered in time never declines the next.

**Amendment 2026-10-01: a question can be answered aloud, and the agent clicks for the user.**
Owner: "we can just also allow voice confirmations. Agents are smart enough to do that, so to force a
confirmation, a user can click yes, but they can also just answer yes", and: "pose this as a tool
that the agent executes … the agent has a confirmation tool which either says yes or no … the agent
is clicking for the user." This supersedes "the hotkey starts nothing" above: while a question shows,
the hotkey answers it (it still starts no new request).
- Holding the hotkey (or the hands-free double tap) while a question shows records an answer, which
  is transcribed as the request was, with no cleanup. The tool's call returns to the model
  `config.connectorToolAnsweredAloud`: nothing was done, the question, and the user's words.
- **The app never reads "yes" itself; the model does**, and answers the question for the user with
  the `confirmation_answer` tool (`config.confirmationTool`, defined in the backend, offered with
  this computer's tools): `confirmed` true runs the call that asked, exactly as the user was shown
  it; false declines it.
- **The tool does nothing unless a spoken answer is waiting.** One waits only after the user
  actually spoke while the question showed, for a confirmation in a later round of the same
  request: one written in the round that asked was written before the user answered, and answers
  nothing (found in review: one round of `[create, confirm true]` ran the tool on a spoken "no");
  any other call (a changed one, another tool's, the same one again) drops it and is asked about as
  before; and a click, a timeout or the request ending leaves none.
- **The confirmation names its question.** Each spoken answer gets its own id, which the model reads
  with the answer (`question_id`, minted by the app: the model's own call ids need not be unique
  across rounds), and `confirmation_answer {question_id, confirmed}` runs the waiting call only when
  it names that id. One naming no question or another answers nothing, and the waiting answer waits
  on; one whose arguments are not a JSON object, or say neither true nor false, uses the answer up
  and runs nothing. Found in review twice: `{confirmed}` alone said nothing of which question it answered, so with
  two questions answered aloud (in one round, or one after the other) the model's "yes" to the
  event ran the message the user had declined aloud. A first fix (only a round's one spoken answer
  waits) closed the one-round case and missed the other; naming the question closes both by
  construction. A question dropped by a later call (the model asked another before confirming it)
  is asked again.
- A spoken answer has its own abort: dropped (another key, a click on the question, the paste
  history), its upload is canceled and not tried again, and words that arrive anyway answer nothing. So the model cannot confirm for
  a user who said nothing, cannot confirm twice, cannot run something the user was not shown, and
  cannot run one question's answer on another.
- Rejected: the app matching "yes"/"no" words itself (every language, and "yes, but on Monday");
  starting a follow-up request from the answer (the model would ask its question a second time);
  and, tried first, letting the same call made again run unasked (the model had to reproduce its
  arguments exactly, and the click had no name).
- The question's clock stops while the answer is spoken and transcribed. An answer that comes to
  nothing (a tap, another key, no words heard, a failed transcription) leaves the question asking
  with its whole time again. A click on the card while speaking answers it and drops the recording.
- Trade-off: an agreeing answer costs one more model round than a click, and rests on the model
  reading the answer rightly; a wrong reading can only decline, ask again, or run exactly what the
  card it names showed. Text the model read earlier in the request (a page, search results) could
  steer it to confirm once the user has said anything; the damage is still bounded by that card.

**Amendment 2026-10-20: an answered question stays, with its answer.** Owner: "when the user answers
vocally, the answer doesn't really show up. We should make the user answer show up as normally, and
have the confirmation dialogue not disappear either"; then, of pages of candidates, "the pressed
button stays, with a little more fading", "the circle spinner just like our main voice circle"
instead of the words "answer aloud, which is not really obvious", "timeout action == decline", "if it
doesn't act, it's just declined", and "make that spinning time a global configuration shared".
- Once answered, a question stays in the chat window where it was asked (`ChatQuestion`, in
  `chat.questions` until its request's turn is added, then in that turn's `questions`). The button
  pressed stays, solid as it was, and the other goes: confirmed, Confirm's blue (a delete's red)
  saying what was done, "Added", "Saved", "Deleted" or "Confirmed", with a tick; declined, Cancel's
  grey saying "Declined" with a cross, the question faded to `chatQuestionDeclinedOpacity` and the
  button to `chatQuestionDeclinedButtonOpacity`. Nothing is struck out. Rejected candidates: a tick
  on the kept buttons, a blue ring and red tint (a declined delete read as alarming, a confirmed one
  as calm), a tinted card, and a label alone.
- An answer given aloud shows as the user's own bubble under the question. Until the model's
  `confirmation_answer` reads it, the thinking circle's spinner, small and alone, takes the buttons'
  place (a small waveform was tried first), and a screen reader hears "Answered aloud"; the model's
  answer then shows on that question (by the id the chat window keeps for it).
- **Everything that spins turns at one speed**, `config.spinnerRevolutionsPerSecond` (the thinking
  circle's 1.2 turns a second): the thinking circle, a running bubble's border and the chat window's
  activity spinner (both 1 before) and the spinner on a question answered aloud. The warm-up swirl's
  orbiting particles keep their own speed.
- **Not acting is declining.** A question left unanswered for `config.chatConfirmationTimeout` is
  declined exactly as a click on Cancel is: the model reads `config.connectorToolDeclined`. This
  supersedes the 2026-09-28 amendment's "the model reads ... 'didn't confirm in time', not the
  decline". An answer aloud the model does not act on (any other call, a confirmation with neither
  true nor false, the request ending) is declined too.
- A request that ends without its turn (canceled, failed) takes its questions with it, as it takes
  its pending request: the chat window is left as it was.

