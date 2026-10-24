## ADR-DESK-020: Agent tools one file each, connectors one folder each

**Context:** Owner, 2026-09-26: agent mode will gain more tools and more connectors (apps a request
is handed to), so the code is split first. All three tools lived in one `AgentTool` enum inside
`DesktopAgent.swift`, their prompt, variables, fitting and delivery spread over that enum's switches,
`DesktopAgent.toolMessage`/`write` and a `switch tool` in `DictationController`; adding a tool meant
editing all of them. The owner chose one file per tool with an enum as the registry, structured like
the Thunderbird add-on (`chat/tools/<tool>.js`, routed by `chat/tools/core.js`) and the iOS app
(`Services/AI/Tools/<Name>Tool.swift` behind the `AgentTool` protocol), over a folder-only move or a
protocol-and-registry design with generic connectors.

**Decision:**
- `Agent/AgentTool.swift` holds the registry: the `AgentTool` enum (raw value = the name the agent
  answers with; `Hashable`, so the phase and the bubbles keep using it) maps each case to its
  implementation, a `AgentTool`. The protocol gives a tool its display name, symbol, backend prompt,
  prompt variables (default: `screenVariables`, the request and the key-down screen read), the fitting
  of the written text (default: as written) and `deliver(_:in:)`. `ToolContext` is what a tool
  delivers with: the dictation's settings snapshot (ADR-DESK-017), the inserter, whether the key-down
  app is still in front, and the connectors.
- `Agent/Tools/` has one file per tool: `EditTool` (fits to the selection, pastes over it),
  `ComposeTool` (adds `terminal_program`, pastes at the caret), `ThunderbirdTool` (hands the message
  to the Thunderbird connector for the snapshot's email app). Edit and Compose paste through
  `ToolContext.pasteIntoTargetApp`, which keeps the `appChanged` check.
- `Agent/Connectors/<App>/` has one folder per connector: `Connectors/Thunderbird/` holds
  `EmailClient` and `ThunderbirdRelay`, unchanged.
- `DesktopAgent` keeps what is about the agent, not a tool: which tools are offered, the choice, the
  write call and its `Failure`s. `DictationController` calls `tool.implementation.deliver` instead
  of switching on the tool.

**Consequences:**
- A new tool is a case in `AgentTool`, a file in `Tools/`, and its prompt name in `DictationConfig`.
  When it is offered stays in `DesktopAgent.tools(for:emailAppAvailable:)`/`tool(for:…)`, since the
  offer rules (the selection picks Edit or Compose; the email app gates Thunderbird) span tools.
- A new connector is a folder in `Connectors/`, passed into `DictationController` and carried in
  `ToolContext`. There is no `Connector` protocol yet: with one connector there is nothing to
  generalize, and the next one decides its shape.
- The bubble's app icon still comes from `tool == .thunderbird` in `OverlayPanel` (left alone while
  another branch changes that file); a second app-backed tool moves it into the protocol.
- No behavior change: the suite passes unchanged except `fitted(_:toSelection:)` moving from
  `DesktopAgent` to `EditTool`.

