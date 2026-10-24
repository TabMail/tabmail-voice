## ADR-DESK-029: Shortcuts, listed and run through the `shortcuts` command

**Retired 2026-09-28, before the first release** (owner: "Let's not support shortcuts for the first
release … I don't need shortcuts at all"). The connector, its tools (`shortcutsTools.ts`), the main
process's `shortcuts.ts`, their tests, config and icon were deleted; the last source is in git
history (PR #41). A stored `shortcuts` in `disabledConnectors` is a retired name and turns nothing
off (ADR-DESK-024). What follows is the decision as it was built.

**Context:** Owner, 2026-09-26: the agent can run the user's shortcuts; running one counts as doing
something, so it is confirmed first (ADR-DESK-023). One switch, on by default, in Settings and the
wizard (ADR-DESK-024). The backend defines `shortcuts_list {query?}` and `shortcuts_run {name}`
(`src/tools/macos/`). First built in the Swift app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `shortcuts` connector with `ShortcutsListTool` (`shortcuts_list`: every shortcut's name, or
  those whose name contains the query ignoring case and accents, at most `shortcutsListMaxResults`,
  more said) and `ShortcutsRunTool` (`shortcuts_run`: one shortcut by its exact name, once
  confirmed; its text output back to the model), in `src/core/agent/shortcutsTools.ts`.
- Both run `/usr/bin/shortcuts` (`ShortcutsRunner`, faked in tests) from the **main process**
  (`src/main/shortcuts.ts`), for ADR-DESK-028's reason: a canceled request or a closed chat window
  ends the command. Whether a shortcut already running in Shortcuts stops with it is unverified (on
  the by-hand list). The name is one argument, never parsed by a shell, after
  `--`, so a name that looks like an option is the name (without `--`, `shortcuts run …
  --help` prints the help and succeeds). The output is asked for as plain text
  (`--output-type public.plain-text`), capped at `shortcutsMaxOutputBytes`.
- A run takes the name the user confirmed and runs only if a shortcut has exactly that name; any
  other name is sent back to the model to look up with `shortcuts_list`.
- A run takes no input, and its stdin is closed at once: `shortcuts` reads an open stdin as the
  shortcut's input and waits for it, so with Node's default pipe every command hung (found by the
  test that runs the real command). Passing the model's text to a shortcut is left for the owner
  to ask for.

**Consequences:**
- No permission of TabMail Voice's own; a shortcut's actions ask for theirs as Shortcuts does.
- Shortcut names and output go to the model only: nothing is stored (ADR-004).
- A shortcut that waits for the user (a dialog, a menu) keeps the request running until it is
  answered or the request is canceled.
- No test runs a shortcut of the user's: the command is a stand-in script, and the real one is only
  asked to run a name like an option, which it looks up and does not find.
- Offered on macOS only, with the other connectors.

