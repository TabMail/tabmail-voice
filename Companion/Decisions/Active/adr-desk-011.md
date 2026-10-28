## ADR-DESK-011: Agent mode on a double tap: the agent chooses a tool, the tool writes the text

> The two calls (choose, then write) are superseded by one tool loop (ADR-DESK-055, 2026-10-05).

> **Amended 2026-09-26 (owner):** the double tap is replaced by **Space during the hold**, the
> selection alone picks Edit or Compose, the bubbles sit still in a row above the pill, and agent mode has no
> timeout. See "Amendment 2026-09-26" at the end of this ADR; the gesture, tool-choice, wait and
> timeout bullets below are superseded where it says so.
>
> **Later (ADR-DESK-021):** the Space hint became a tip that retires once learned, and a double tap is
> back, for hands-free dictation (not agent mode).
>
> **Later (ADR-DESK-042):** the "You switched apps, so nothing was pasted" check is gone: every paste
> goes where the caret was at key-down, or onto the clipboard and into the paste history. Amended the
> same day: only the app is checked, for dictation and agent mode alike (`focusChanged`), and a text
> for another app goes onto the clipboard and into the paste history instead of failing.

**Context:** Owner, 2026-09-25: a double tap of the hotkey enters agent mode. Speech is then a
request to carry out, not text to insert. The first tools are **Edit** (rewrite the selected text
as asked, like Thunderbird's inline editor) and **Compose** (write new text at the caret, for any
app, not only mail). Their bubbles show around the pill (owner, 2026-09-26: they float around it
and wiggle a little, "not too much": left, under and right of it, over it when the pill sits above
the caret, so none covers the caret's line); after the request, the chosen tool's
bubble border circles while it runs. The prompts are the desktop's own, reusable by any later
desktop platform, not the Thunderbird email prompts.

**Decision:**
- Gesture (`PushToTalkGesture`): a press released within `minimumHoldDuration` is a tap. A press
  within `doubleTapWindow` of a tap's release starts agent mode. Held, it finishes on release
  like a dictation; tapped, agent mode listens hands-free until the next press. Typing cancels,
  as during a hold. Both readings of "double tap" work, so neither had to be ruled out.
- Two backend calls, both `POST /completions/chat` template prompts in the backend's `common/`
  registry at v0.1.0 (backend ADR-023). `system_prompt_desktop_agent` (light tier) chooses the
  tool from the request, the selection, the app and the window title, and answers `Tool: edit` or
  `Tool: compose`. The phase becomes `running(tool)` and the tool's prompt
  (`system_prompt_desktop_edit` / `_compose`, heaviest_fast tier) writes the text from the request
  and the screen context. Separate calls let the bubble show the chosen tool while it works, and
  each tool gets a prompt of its own.
- Edit pastes over the selection, which the non-activating overlay leaves in place; the result
  keeps the selection's own leading and trailing blank space (a selected line keeps its line
  break). Compose pastes at the caret; with text selected it first collapses the selection to its
  end (→), so the selected text stays.
- The selection is the one the key-down screen read (ADR-DESK-007) found. Agent mode waits
  `agentContextWait` (2 s) for that read, not the dictation's 0.5 s: an edit cannot work without
  it.
- A failed request pastes nothing and says why: no known tool, an edit with nothing selected, an
  empty text, a timeout (`agentChooseTimeout`, `agentToolTimeout`) or a backend error. Unlike the
  dictation cleanup, there is no "paste as heard": the spoken request is not text for the document.

**Consequences:**
- Agent mode adds a model round trip before the tool runs (light tier, reasoning off).
- No client-side tools: the Mac app at 0.1.0 would read Thunderbird's tool registry, and a
  desktop tool listed there would reach Thunderbird's agent too. *(Later (ADR-DESK-023): the app has
  its own `macos` registry, and the Answer prompt calls tools that run on the user's computer.)* The later Thunderbird connector
  follows the same tool-choice contract (a third tool name; ADR-DESK-014).
- Apps whose accessibility tree hides the selection (thin trees, some Electron apps) can't be
  edited; the request fails with "Select the text to edit". Copying the selection with ⌘C
  instead would be a fallback: an owner decision.
- With screen reading switched off (ADR-DESK-010), there's no selection, so Edit never runs.
  Whether Edit reads the selection anyway is an owner decision.
- The selected text and the screen are sent to the backend with the request; nothing is stored
  (root ADR-004). The prompts treat both as content, never as instructions.

**Amendment 2026-09-26 (owner):** "I dislike the double tap"; Edit or Compose "should depend
exactly on … whether we have selected text or not, and … only either of the 2 icons should show";
the bubbles wiggled too much ("appearing alongside looks okay"); "agent should not have timeout".
- Gesture: every hold starts as a dictation; **Space during the hold** switches between dictation and
  agent mode (`PushToTalkGesture.Action.toggleMode`), any number of times; other keys still cancel.
  `HotkeyMonitor` is now a `CGEventTap` (Accessibility, as before) so that Space, its auto-repeat
  and its key-up are kept from the app in front; a key monitor can only observe. The double tap,
  hands-free listening and `doubleTapWindow` are gone. While the pill listens, a hint under it (over
  it when the overlay opens upward) says "Space to toggle agent mode" / "Space to disable agent mode";
  later the same day made quieter at the owner's request: a small "space" keycap with "agent mode" /
  "exit agent", no border. Later again (owner: "a tooltip that appears below the middle and
  disappears after a little"): a tooltip centered under the pill, with an arrow up at it, always
  below (even when the overlay opens upward, since it is brief), fading after
  `modeHintDisplayDuration` (2.5 s), once a hold. Then styled as a system tooltip (owner: the light
  one "looks cheap … almost a black background"): a near-black rounded box with a hairline border
  and a soft shadow, white text, a raised "space" keycap, the arrow part of the same outline.
  The overlay opens below the caret's line only when the listening pill and the hint under it both
  fit on screen there (`opensUpward` counts the hint's `modeHintFootprint` and the listening pill's
  real height, `listeningPillHeight`); otherwise the hint's lower half went off the bottom of the
  screen for a caret a line or two above it. Opened above a caret on the screen's bottom line, the
  overlay is raised as far as the hint under the pill needs to stay on screen.
- Tools: Edit when the key-down screen read found selected text, Compose when not
  (`DesktopAgent.writingTool`); never both. No bubble shows until that read is done, and agent mode
  waits for the whole read (no `agentContextWait`), so the tool that runs is the one shown. The agent
  prompt now only decides whether a request goes to the email app (ADR-DESK-014): it is not called
  when there is none, and its pick of the other writing tool gives way to the selection's.
  Consequently "Select the text to edit" and "Compose after the selection" (→ collapse) are gone: a
  selection always means Edit.
- No deadline on agent calls: `agentChooseTimeout`, `agentToolTimeout` and `Failure.timedOut` are
  removed. The completions request keeps its idle timeout (`completionsRequestTimeout`, a pause
  between stream bytes; the backend sends keepalives), which is a dead-connection check, not a cap.
- Bubbles sit level with the pill, first to its right, then its left, with no drift (later the same
  day, owner: "appear on top … like a list on top": one row centered above the pill; the hint then
  went over the whole stack when the overlay opened upward, until it became the tooltip above); they are icon-only circles (20 pt, 13 pt app icon, 10 pt symbol): with one writing tool shown, the name
  adds nothing (owner). The name stays as the accessibility label. Owner, later the same day: small
  but slightly larger (now 24 pt, 16 pt app icon, 12 pt symbol), and the running tool's bubble grows
  further, "sort of like a genie effect", so the tool in use is obvious: it springs up to 1.4× from its
  bottom edge, away from the pill, with a little overshoot (`agentBubbleRunningScale`).
- The "sometimes works" failures the owner saw were not timeouts: the dev backend log showed the
  agent model drafting text after `Tool: compose`, and the edit/compose model continuing the lone
  system message (`</request>`) or answering empty. Fixed in the backend (ADR-023 amendment: the
  request is the final user turn, and the agent's first word after `Tool:` counts).
- With no deadline, the user may move to another app before the text arrives. Edit and Compose paste
  only while the app that was in front at key-down still is; otherwise the request fails with "You
  switched apps, so nothing was pasted" (`DesktopAgent.Failure.appChanged`, 2026-09-26 review). The
  Thunderbird tool is exempt: it brings Thunderbird to the front itself, and has its own focus checks.

**Amendment 2026-10-19 — the knowledge base and writing style (ADR-DESK-063).** Agent mode's
request now also carries the user's knowledge base (`user_kb_content`, always) and writing style
(`user_composition_prompt`, its three sections only, when Compose or Edit is offered), both read at
key-down, and the loop offers `kb_add` and `kb_del`. A chat window closing after at least three
requests sends its requests and replies to the backend's knowledge-base refine (*removed 2026-10-27:
closing a chat sends nothing; ADR-DESK-063's amendment of that date*).
