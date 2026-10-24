## ADR-DESK-062: The default event duration, in Settings and set by agent mode's Settings tool

**Context:** Owner, 2026-10-18: an event added with no end lasted a fixed hour
(`config.calendarEventDefaultDuration`); the user must be able to choose it, as in Thunderbird, in a
small menu inside the Calendar item of Settings' Agent mode, and agent mode must be able to set it
too, through a Settings tool of Voice's own ("we should have definitely voices, the own settings
menu ... settings tool").

**Decision:**
- **The setting.** `AppSettings.eventDuration` (stored as `eventDurationMinutes`): whole minutes from
  `config.eventDurationMin` to `config.eventDurationMax` (5 to 720, the range Thunderbird's and iOS's
  `change_setting` take), `config.eventDurationDefault` (45, Thunderbird's and iOS's default) until
  set. A stored value out of range reads as the default; one the file can't keep is refused and the
  setting stays as it was.
- **Settings.** "Default event length" sits under the Calendar switch in Agent mode, a menu of
  Thunderbird's choices (`config.eventDurationChoices`: 15, 30, 45 minutes, 1 hour, 1h 30m,
  2 hours, labelled as Thunderbird labels them); a value agent mode set that is not among them is
  listed too, in order, so the menu always shows the one in force. It sends `setEventDuration`; a
  failure to save is shown beside it.
- **The Settings connector.** `settings.ts` declares a connector `settings` ("Settings", on every
  platform) with one tool, `change_setting`, Thunderbird's and iOS's name and key
  (`calendar.default_event_duration_minutes`), today with that one setting. It asks nothing first:
  it sends nothing and creates nothing, and its result says what it set. Like every connector it has
  a switch, and its tool is offered only while that is on. An unknown setting, or a value that is not
  a whole number of minutes in range (a number or a numeric string), is a `ToolArgumentError` the
  model reads; a value that can't be saved is reported as not changed.
- **Snapshot.** A request's tools read the duration of its key-down (owner rule: snapshot settings
  at operation start): the controller passes `ToolSettings` (from `DictationSettings`) to every
  `ConnectorTool.confirmation` and `run`, so a question and the event it adds use the same duration
  even if it changes meanwhile; a change, from Settings or `change_setting`, applies from the next
  request, which the tool's result tells the model.
- **Edits.** An all-day event made timed (ADR-DESK-060) lasts the same duration, from its new start
  or back from its new end; a timed event keeps its own length.

**Consequences:**
- The default changes from an hour to 45 minutes, matching Thunderbird and iOS.
- The backend offers `change_setting` to Voice only from the version that declares it
  (`src/tools/voice/change_setting-v<version>.json`, with the key and range above); an older app is
  never offered it.
- Tests: see `TESTS.md` (the default event duration row).

---

