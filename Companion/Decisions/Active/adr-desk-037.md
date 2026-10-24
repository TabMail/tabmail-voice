## ADR-DESK-037: The Thunderbird tool is off until its native connector

> Since ADR-DESK-055 (2026-10-05) agent mode is one tool loop: bringing this tool back means offering it as a loop tool, and the chooser this ADR describes is gone.

**Context:** Owner, 2026-09-29: "we should actually disable the Thunderbird tool so that we can test
all the others. And then for the Thunderbird tool, we should only use it … after introducing the
native connector, because right now it's just clunky." The tool drives TabMail's chat in
Thunderbird from outside (ADR-DESK-014's spike: shortcut, paste, Return). The native connector is
ADR-DESK-014's option B, a native-messaging bridge to the add-on, being built separately.

**Decision:**
- `offeredAgentToolIDs` (Edit, Compose, Answer) is what agent mode offers and what Settings and the
  welcome wizard list; `agentTools` stays the registry of every tool, Thunderbird's included, so a
  bubble or a stored switch still names a tool (`isAgentToolID`). `AppSettings.enabledTools` is drawn
  from `offeredAgentToolIDs`, so no dictation offers Thunderbird's tool, and the agent is never told of
  it (`available_tools`).
- Its switch, and Settings' Email app menu (which only chooses where that tool sends), are hidden. A
  switch the user stored for it is kept, for when it returns.
- Its code stays (`ThunderbirdTool`, `ThunderbirdRelay`, the email app's resolution and icon), and
  the controller's tests still run it with a tool list that offers it.

**Consequences:**
- Mail and calendar requests go to Answer, whose Calendar, Reminders, Email and other connectors
  carry them out; the backend's agent prompt says which requests each tool takes (ADR-023
  amendment, 2026-09-29).
- Bringing the tool back is offering it in `offeredAgentToolIDs`, with the native connector as its
  delivery. Settings' tests of the Email app menu (its choices, and its three notes by email-app
  case) were taken out with it and come back from this change's history.

