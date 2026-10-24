## ADR-DESK-044: The code in folders by concern, each with a place for what comes next

**Context:** Owner, 2026-09-30: the agent's tools sat in `src/core/agent/` beside the agent, its
chat and the connectors, with nothing to say which file is a tool, and `native/macos/Sources/` mixed
the lowercase executables (`voice-hotkey`, `voice-macos`) with the libraries, `VoiceMacOSKit` one
flat folder of everything the helper does. The owner asked for a layout where it is plain where a
tool goes, as in the iOS app (`Services/AI/Tools/`), Thunderbird (`chat/tools/`) and the backend
(`src/tools/<platform>/`), that scales as tools, connectors, platforms and windows are added, and
that Thunderbird counts as a connector; a reorganization only, with no change to what the code does.

**Decision:**
- No file repeats its folder's name (owner, 2026-09-30: "no repeated folder names in the sub names"):
  the folder says what it holds, the file what part it is (`agent/chat.ts`, not
  `agent/agentChat.ts`), and an entry point is `index` (`main/index.ts`, `preload/index.ts`, each
  window's `index.html`). Swift keeps its own convention, a file named for the type it declares.
- `src/core/agent/`: the agent's requests to the backend (`requests.ts`, `DesktopAgent`), the chat
  window's conversation (`chat.ts`), the bubbles' order (`bubbleOrder.ts`) and agent mode's own
  tools, Edit, Compose, Thunderbird and Answer (`tools.ts`); then `connectors/`, the apps Answer's
  model reaches on this computer: one file per connector with its tools (`calendar.ts` … `web.ts`;
  **a new tool goes in its connector's file, a new connector is a new file**), the contract both
  keep (`contract.ts`), the generated list of them (`registry.ts`) and what the rest of the app reads
  (`index.ts`), the AppleScript runner Notes and Messages go through (`appleScript.ts`) and
  `thunderbird/`, the relay to TabMail's chat (`relay.ts`) and the
  email app it drives, where its native connector will go (ADR-DESK-037). A connector that needs
  more than a file gets a folder, as Thunderbird has.
- The rest of `src/core/` by concern: `dictation/` (the controller, the cleanup, the screen read,
  the paste history), `audio/` (the recorder, levels, WAV and FLAC), `backend/` (sign-in, the
  completions and transcription clients, their errors, HTTP), `dictionary/`, `hotkey/`,
  `onboarding/` (the wizard, permissions, tips, the VS Code fix), `ui/` (the overlay's geometry, the
  tray menu's model) and `util/`; `config.ts`, `log.ts` and `settings.ts` stay at its top, as every
  part reads them.
- `src/main/`: `index.ts` wires the app; `native/` is the app's side of the OS helpers
  (`helperClient.ts`, `macos.ts`, `osascript.ts`); **Windows' and Linux's go beside them.**
  `storage/` holds what the app keeps: the sign-in, the preferences file, the debug log and
  Thunderbird's profiles read. The windows, the tray, the microphone, the updater and the
  permissions stay at its top.
- `src/renderer/`: each window is a folder, `<page>/index.html` (what Vite builds and the window
  loads, `dist/renderer/<page>/index.html`), `index.tsx` and `index.css`, with anything else only it
  uses; what the pages share is in `shared/`. **A new window is one folder.**
- `native/macos/Sources/`: each helper is an executable target named as the libraries are
  (`VoiceHotkey`, `VoiceMacOS`: only its `main.swift`) over its library (`VoiceHotkeyKit`,
  `VoiceMacOSKit`), beside `VoiceHelperSupport`, the line protocol both use. The products keep the
  executables' names, `voice-hotkey` and `voice-macos`, which the app spawns and ships.
  `VoiceMacOSKit` has `MacService` (the requests) and `HelperConfig` at its top and the rest in
  folders by concern, mirrored in its tests: `Dictation/` (paste, microphone, caret, focused field,
  keyboard language, the screen read), `System/` (Accessibility activator, apps, Globe key) and
  `Connectors/` (Calendar and Reminders, Contacts, Files: what the TypeScript connectors reach).
  *(Amended 2026-10-01: a third helper, `voice-microphone` (`VoiceMicrophone` over
  `VoiceMicrophoneKit`), has the microphone, which left `Dictation/`: ADR-DESK-032's amendment of
  that day. A new helper follows the same shape: `voice-<what>`, `Voice<What>`, `Voice<What>Kit`
  with its `<What>Service` and `HelperConfig`, and `Voice<What>KitTests`. The names' rules are in
  `PROJECT_STRUCTURE.md` › Naming.)*
- `test/` mirrors `src/`: a module's test has its name and folder under `test/` (the renderer's
  `<page>/index.test.ts`), a test file tests one module, shared stubs and the fake helper are in
  `test/support/`, and the package's checks (`packaging.test.ts`) are at the top.
- Names follow the TypeScript conventions (owner, 2026-09-30: "make things more standard"), renamed
  with the language service so only real references changed:
  - Error classes end in `Error`, as JavaScript's own do: `AgentFailure` → `AgentError`, likewise
    `ContactStore…`, `EventStore…`, `FileStore…`, `Helper…`, `Microphone…`, `NoEmailApp…`,
    `Relay…`, `Script…` and `WebRead…` (their `…Kind` types too), `NotPasted` → `NotPastedError`,
    `LoopToolArgumentError` → `ToolArgumentError`. The kinds, the helper's wire codes, are unchanged.
  - An acronym is written in capitals, as the code already had it (`HTTPRequest`, `JSONFileStore`,
    `bundleID`, `mailtoURL`): `userId` → `userID`, and the SVG hook `useSvgId` → `useGradientID`.
  - A list of names is `…ID`, the object it names takes the plain noun: `AgentTool` (the names:
    edit, compose, thunderbird, answer) → `AgentToolID`, `agentTools` → `agentToolIDs`,
    `offeredAgentTools` → `offeredAgentToolIDs`, `isAgentTool` → `isAgentToolID`; the tool itself,
    `DesktopTool` → `AgentTool`, and `toolImplementations` → `agentTools`. `Connector` →
    `ConnectorID`, `connectors` → `connectorIDs`, `isConnector` → `isConnectorID`.
  - `LoopTool` → `ConnectorTool` (`connectors/contract.ts`): a tool a connector brings, not the
    backend's loop it runs in; `loopTools` → `connectorTools`, `config.loopToolDeclined` and
    `loopToolUnanswered` → `connectorToolDeclined` and `connectorToolUnanswered`.
  - The main process's preferences file, `FileStore` → `JSONFileStore` (`storage/jsonFileStore.ts`),
    as the Files tools' `FileStore` is the Spotlight one.
  - `config.ts` keeps its rule, durations in milliseconds unless the name says otherwise; the four that
    were seconds without saying so say it: `pillSpringResponseSeconds`,
    `agentBubbleRunningSpringResponseSeconds`, `agentBubbleMoveDurationSeconds`,
    `chatAppearDurationSeconds`; the two milliseconds that said so drop the suffix
    (`webReadTimeoutMs` → `webReadTimeout`, `webReadRobotsTimeoutMs` → `webReadRobotsTimeout`).
- The connectors' list is generated, as the backend's tool registries are (owner, 2026-09-30:
  "someone doesn't have to remember to update both registry and tool file"). Each connector is
  declared once, in its own file: `export const webConnector = defineConnector({ id, order,
  displayName, settingsDescription, serverTools?, tools(services) })`. `scripts/gen-registries.mts`
  (`npm run gen:registries`, run before every build, typecheck and test run) writes `registry.ts`, marked
  AUTO-GENERATED, with the `ConnectorID` union and the connectors in their `order`. `index.ts`
  derives `connectorIDs`, `isConnectorID` and `connectorByID`, replacing the hand-kept
  `connectorInfo` and `connectorServerTools`. The main process builds every tool from the list over
  one `ConnectorServices`, the OS access (Calendar and Reminders, Contacts, Files, the email app,
  osascript, the web). The order keeps the switches and bubbles where they were. A test fails when
  `registry.ts` is behind the files, and the generator refuses a declaration it can't read and an id
  or order used twice. Only the icons stay beside the pages (`icons.tsx`, a `Record<ConnectorID>`, so
  a connector without one doesn't compile).
- American spelling throughout (owner, 2026-09-30: "consistent american spelling"), in names, CSS
  classes, UI text, comments and docs, as the platforms' own APIs have it (`color`, `center`):
  `brandColour` → `brandColor`, `hintCentre` → `hintCenter`, `grey` → `gray`, `honoursCancel` →
  `honorsCancel`, the `centred` class → `centered`, "Cancelled." → "Canceled.", and likewise
  behavior, neighbor, favor, -ize, labeled, signaled, modeled. Only URLs keep their spelling.
- Beyond the moves, only import paths, the pages' script and entry paths, `Package.swift`'s target
  names, the paths tests read from disk and the names above changed; the backend clients' module
  was split in three (`completions.ts`, `transcription.ts`, `errors.ts`, the request log and headers
  joining `http.ts`), and tests that covered several modules were split to one file each.

**Consequences:**
- A branch open before this change rebases with git's rename detection; a file it adds under an old
  folder moves by hand, and its imports follow.
- Verified against `main` at 0.1.2: the same suites pass in the same numbers, the build gives the
  same pages and helpers, and `npm run preview` renders every window as before (the frames that
  differ are the animated ones, which differ between two renders of `main` too).

