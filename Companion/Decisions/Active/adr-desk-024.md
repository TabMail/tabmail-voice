## ADR-DESK-024: Calendar and Reminders, the first apps the Answer tool reaches

**Context:** Owner, 2026-09-26: the Answer prompt's tools reach the user's apps, each a switch in
Settings and the welcome wizard, "toggleable on by default"; "sending or creating anything, you
should ask for confirmation first"; a macOS permission refused fails with a message saying where to
grant it. The backend defines the four tools (`calendar_read`, `calendar_event_create`,
`reminders_read`, `reminder_create`, `src/tools/macos/`), their dates ISO 8601 without an offset, in
the user's zone. First built in the Swift app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- A connector is an app the tools reach (a `Connector`, declared in its own file in
  `src/core/agent/connectors/` with its display name and description, ADR-DESK-044), and each `ConnectorTool` names its `connector`. Settings stores the switched-off
  names (`disabledConnectors`, so a new connector starts on and a retired name is ignored); the
  enabled ones are in the key-down snapshot (`DictationSettings.enabledConnectors`, ADR-DESK-017),
  and a request lists in `available_tools`, and runs, only the tools of the connectors on then. The
  switches follow the agent tools' in Settings' Agent mode and the wizard's Features step
  (`setConnectorEnabled`).
- The tools are `src/core/agent/connectors/calendar.ts` over an `EventStore` the main process gives them;
  on macOS that is `voice-macos` (`EventStore.swift`, EventKit), elsewhere there is none and no
  connector is offered or shown. Reads need nothing confirmed; adding an event or a reminder asks,
  and the question is built from the same draft the tool then adds, so what is confirmed is what is
  added. A day as an event's start is an all-day event; with no end, an event lasts
  `config.calendarEventDefaultDuration` (an hour; since 2026-10-18 the user's default event duration,
  45 minutes unless changed, ADR-DESK-062); a day as an end means through that day, and an
  all-day event over several days reads as its first to its last day. Bad or missing arguments
  throw `ToolArgumentError`, which the model reads (ADR-DESK-023).
- The backend's dates are parsed in the local zone in core (`LocalDateTime`), and cross the wire as
  milliseconds since 1970, so the helper does no date parsing; a reminder due on a day carries
  `dueHasTime: false` and is stored with no time. A reminder's due date is stored as Gregorian
  components in the Mac's zone (`ReminderItem.dueCalendar`), as EventKit reads them whatever
  calendar the Mac is set to: in the Mac's own calendar a Buddhist-calendar Mac stored a date 543
  years late. The helper sets an event's `isAllDay` before its dates (`EventKitStore.fill`): set
  after, EventKit moves an all-day event's end back to its first day, losing the rest.
- `calendar_read` refuses a range longer than `config.calendarReadMaxDays` (four years of 365
  days): EventKit reads at most four years of events for one request and silently drops the rest,
  so a longer read would report events missing. The model is told to read it in parts.
- `EventKitStore` takes its `EKEventStore` and authorization status (EventKit's own by default),
  and `MacService.register` its `EventKitStore`, so the helper's tests read and save through a
  stand-in `EKEventStore` subclass, never the user's calendars.
- The helper asks for full access on first use (`requestFullAccessToEvents`/`…ToReminders`); the
  packaged app carries the usage strings (`NSCalendarsFullAccessUsageDescription`,
  `NSRemindersFullAccessUsageDescription`) and the `personal-information.calendars` entitlement,
  since the prompt is attributed to the app. A refusal (a request for access that fails counts as
  one), or no default calendar or list, goes back by
  name (`calendarNoAccess`, `remindersNoAccess`, `noDefaultCalendar`, `noDefaultList`) and becomes an
  `EventStoreError` whose message names where to grant access (System Settings › Privacy &
  Security › Calendars or Reminders); the model reads it and tells the user.
- A call waits `config.eventStoreRequestTimeout` (two minutes), long enough for the user to answer
  the permission prompt.

**Consequences:**
- A new connector is one file declaring it (`defineConnector`), taking its OS access as an interface,
  and the helper methods behind it; the switch, the snapshot and the offer come with the name.
- The permission prompt raised from a helper process, attributed to the app, is checked by hand on a
  signed build (TESTS.md).

