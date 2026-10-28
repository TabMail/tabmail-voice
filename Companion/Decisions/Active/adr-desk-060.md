## ADR-DESK-060: Calendar events are edited, deleted and shared, at parity with Thunderbird and iOS

**Context:** Owner, 2026-10-17 (issue #117): the calendar tools as Thunderbird's and iOS's are, and
"we need to be able to edit calendar entries, not just add people": repeating events, invitations,
the organizer, busy or free, the calendar an event goes in, `calendar_event_edit` (one occurrence or
the series, and occurrences left out), `calendar_event_delete`, `calendar_event_read`, and
`calendar_read` with pages, ids, attendees and recurrence; every create, edit and delete confirmed.
EventKit reads an event's attendees but has no public way to write them. Tried on the owner's Mac
before choosing: AppleScript (Calendar's `attendee` elements are read-only; making one fails), an
`.ics` file opened in Calendar (it asks which calendar, imports, and sends nothing), CalDAV to each
server directly (a second sign-in per account, which EventKit already has), and the methods Calendar
itself invites with, which EventKit keeps to itself. The owner chose the last, checked at run time.

**Decision:**
- **Inviting through Calendar's own methods** (`Invitations.swift`): an attendee made by
  `+[EKAttendee attendeeWithName:emailAddress:]`, added by `-[EKCalendarItem addAttendee:]`, removed by
  `-[EKCalendarItem removeAttendee:]`, and, on an event's first invitation,
  `addOrganizerAndSelfAttendeeForNewInvitation` (the organizer and the user, as Calendar adds them).
  Each is looked up when used (`class_getClassMethod`/`class_getInstanceMethod`), never linked, so a
  macOS without one refuses (`invitationsUnavailable`) instead of crashing. Once the event is saved,
  its calendar's server emails the invitations, updates and cancellations, as it does for Calendar's
  own; the helper sends nothing. Inviting needs a calendar a server shares (CalDAV, which Google and
  iCloud are, or Exchange; `calendarNoInvitations` otherwise). Measured: Google sends the invitation
  and its updates; an Exchange event saves with its attendee and keeps later edits.
- **The wire.** `calendarEvent {id, occurrence}`, `calendars`, `calendarEdit` and `calendarDelete {id}`
  beside `calendarEvents` and `calendarAdd`; `calendarAdd` also takes `calendarId`, `availability`,
  `recurrence` (null for none) and `attendees`. An event crosses with its `id`
  (`eventIdentifier`), `occurrence` (the occurrence's original start, ms), `calendarId`,
  `availability` (`busy`/`free`), `attendees` (`{email, name, status}`), `organizer`, `recurrence`
  (`{frequency, interval, count, until, days: [{weekday, week}], monthDays, months, positions,
  yearWeeks, yearDays}`, what one `EKRecurrenceRule` says, read in full: "the last weekday" is Monday
  to Friday at position -1, and a rule read without its positions would say more occurrences than it
  has; the model's own rules take no positions or year fields, and anything else Calendar would drop
  or misread is refused in core; a count past the largest safe integer is refused there, and the
  helper refuses a rule with any field it can't read rather than reading it as absent, which for a
  count would repeat for ever),
  `isDetached` and `isInvitation` (attendees, and an organizer who isn't the user). People are removed
  by their addresses only, those the user confirmed: a "remove everyone" would take in someone added
  while the user is asked. `calendarEdit`'s
  `recurrence` absent keeps the rule and null clears it. Calendars come with whether each is the
  default, and only those whose events can change.
- **Finding an occurrence.** `event(withIdentifier:)` returns a series' first occurrence, so an
  occurrence of a repeating event is found by its id and `occurrence` among the events of its calendar
  within `HelperConfig.eventOccurrenceSearchSpan` (31 days) of it, matched within
  `eventOccurrenceTolerance` (two hours, 2026-10-18; it was an hour): the app gives and takes an
  occurrence by its local time, which in the hours a clock turned back repeats reads as the earlier of
  two instants, as far before the later as the clock turned back, two hours at most (Antarctica/Troll);
  and a series' occurrences are nearly a day or more apart. An occurrence changed on its own (detached) has an id of its
  own (`<series>/RID=<seconds>`), which names it alone, so it is returned by that id however far it
  moved (Apple documents its `occurrenceDate` as its original start; the live test read its moved
  start, and the lookup depends on neither). A single event is found only at its own start: an
  occurrence named while it still repeated names nothing once it stopped.
- **Scope.** `edit_scope` `this_only` (the default with `recurrence_id`) saves with `.thisEvent`;
  `this_and_following` with `.futureEvents` from that occurrence (EventKit splits the series); `all`
  (the default without) edits the series from its first occurrence with `.futureEvents`, any new
  times moved by as much as the target occurrence's. A recurrence change always saves `.futureEvents`.
  Moving the series moves every occurrence by as many calendar days as the target moves, to its new
  time of day, never by a number of seconds: across a daylight-saving change that would land an hour
  off, or an all-day series on the day before. The occurrence named itself takes the start and end
  confirmed as they are (rebuilt from a time of day, one in the hour a fall-back change repeats would
  be the earlier of its two), and a timed series moved from a later occurrence keeps the length
  confirmed, an all-day one its days (2026-10-18). A series whose rule names its days (`BYDAY`,
  `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`) moved to another day is refused unless
  the edit gives the rule it moves to, which the user then confirms: the start would no longer be one
  of the rule's days, which RFC 5545 leaves undefined. The day is counted in the event's own zone
  (the helper sends `timeZone`, null for a floating event, counted in the Mac's), where EventKit counts
  the rule's days and the helper moves the series: a move within the Mac's day can cross one there. A detached occurrence carries its series' rule
  in EventKit, yet is changed alone, by its id with or without `recurrence_id`: the app sends it as
  `this_only`, and the helper saves it with `.thisEvent` whatever scope arrives (as delete does), since
  `.futureEvents` would save it over every later occurrence. It takes only `this_only` changes.
  `exdates_add` removes the occurrences named before the rest of the edit, once the edit is checked
  (the event editable, invitations possible) and every one of them found as an occurrence of the
  series: a refusal removes none. It is refused with new times for the series (`all`,
  `this_and_following`): the move would bring the deleted occurrences straight back (RFC 5545 excludes
  only start times the moved rule still makes), so the model moves the series first, reads it, and
  deletes the occurrences at their new times. Each removal commits at once (`.thisEvent`, `commit: true`), so none
  is left pending in the helper's long-lived `EKEventStore` for a later save to commit. A save that
  fails after them leaves them removed; the model is told to check the calendar before trying again.
  `calendar_event_delete` removes a whole series (`.futureEvents` from its first) or, for a detached
  occurrence, that one; the question and the result say "every occurrence" only for a series.
- **The confirmation says what changes**: each field, who is invited or uninvited ("emailed the
  change"), the occurrences deleted, and for a series moved in time, "Every occurrence covered moves by
  as much, and any deleted from the series come back": measured on Google, moving a series' time
  restores the occurrences left out of it, as Google's own Calendar warns. Deleting an event the user
  was invited to says it only leaves the user's calendar; one the user organized, that attendees are
  emailed a cancellation. Changing an event the user was invited to is refused (`notOrganizer`).
- **Asked first, whatever fails.** A create, edit or delete whose question can't be made (its
  arguments, a read of the event or the calendars failing, the helper restarting) throws from
  `confirmation`, and the controller tells the model why and runs nothing: a question that comes
  back empty would run the write unasked. Edit and delete run the change the question was made from
  and never plan it again: `confirmation` keeps it for the arguments it was asked with (as
  `PDFReadTool` does), and `run` takes it once, so an event changed in Calendar while the user is
  asked gets the times and loses only the people the user was shown. A run with no question kept for
  its arguments, or a request canceled before it writes, writes nothing; the helper still refuses an
  event that is gone, read-only or not the user's when it saves. (Amended 2026-10-18: edit and delete
  read the event again when they ran, so a duration changed meanwhile moved the end past the one
  confirmed, and a person named but absent when asked was removed once added.)
- **Without an editor** (Windows, which has no event store; Linux has one from 2026-10-27, amendment
  below), the read, edit and delete
  tools aren't offered, and a create with `calendar_id`, `transparency` free, `attendees` or
  `recurrence` is refused (busy, the default, goes ahead: 2026-10-18). `calendar_read` pages at `config.calendarReadPageSize` and lists the calendars on page 1.
  The backend's schemas for this are `v0.2.5` (its ADR-017 amendment): an older app is never offered
  them.

**Consequences:**
- The invitation methods are Apple's private API: a macOS update can remove or change them. The check
  at run time turns removal into a refusal the model reports; a changed signature would not be
  caught, so each macOS release is checked by hand (TESTS.md).
- Measured on Google: renaming a series renames its detached occurrences, which keep their times;
  deleting a series deletes them; a series split with `this_and_following` survives a later move of
  the original.

**Amendment 2026-10-18: the question draws the event, and an invitation is refused before it.**
Owner: "Some of the contents are not really that apparent in the calendar entries. The iOS ones look
more apparent though … a little bit of a more polished confirmation dialogue. Don't be too much"; of
five candidates on a page, "Date tile looks awesome".
- A calendar question's `confirmation` returns its words and an `EventQuestion` (`core/agent/chat.ts`):
  the action, a caption naming the occurrences ("Change this occurrence", "Delete every
  occurrence"), the page of the event's day (month, day, weekday), its title and time with the new
  ones that strike them out, and a line per other thing it says, each with an icon and a tone (added
  in the accent, removed struck out, a note of who is emailed in the secondary color). The chat
  window (`AgentChat.confirmationEvent`) draws the card in place of the words: a small calendar page
  beside the title and time, the lines under them, and a button that says what confirming does
  ("Add", "Save", "Delete"), red for a delete with the page greyed and its month red. A person shows
  with their address, so the user sees who is emailed.
- The words still say all of it, and are what the model reads when the user answers aloud
  (`connectorToolAnsweredAloud`); every other tool's question stays words alone. The card's dates
  are English and Gregorian (`en-US`), the only language and calendar the app supports, so the page's
  month, its day and the year check count one calendar; a time on another day than the page names
  its days. A deletion's card does not restate a stored rule: Calendar can hold rules a summary
  would misread (the last weekday of the month read as every weekday), and its caption already says
  every occurrence goes.
  The page has no year, so a day outside this year is always named with its year (the time, an
  all-day event's days, an occurrence dropped), as Apple's Calendar does: a wrong year from the model
  is seen before the user confirms by click. The confirm button's colour comes from its class alone
  (brand blue, `destructive` red), so nothing inline can override it.
- Changing an event the user was invited to is refused when the question is prepared, from the
  event the edit reads anyway, so the user is never asked to confirm a change that can't be made
  (it was refused by the helper only after Save). The helper's refusal stays.
- People and screen readers (owner, 2026-10-18, chosen from a page of candidates: "the new
  recommendation looks good … and the screen reader fix as well"). The people a question invites,
  and those it removes, are each one list under one icon and a small "Invite" or "Remove" label,
  each person written "name <address>" in one color: the address is who is emailed, so it is never
  fainter than a name the model chose. The grouping is the renderer's (consecutive person lines of
  one tone); the card's data is unchanged. A screen reader hears what the strike-out, the accent and
  the icons show: the page as "Thu, Oct 22", "Title changes from … to …", "Invited: …",
  "Removed: …", a line's field where its icon names it ("New location: …", "Removed occurrence:
  …"), and "New: …" on any other new line (a new repetition), with removed text in `<del>` and a
  new title or time in `<ins>`; nothing changes on screen.

**Amendment 2026-10-27: Linux edits events through Evolution Data Server (voice #230).**
Owner: "linux now can be implemented safely … all we need is integrating properly". Windows stays
without an editor (voice #229: its app calendar is invisible to the user and has no invitations).
- `voice-productivity` answers `calendarEvent`, `calendars`, `calendarEdit` and `calendarDelete`
  with the Mac helper's parameters and replies, and `calendarAdd` takes the same extended fields
  (calendar, availability, recurrence, attendees). `NativeEventStore` has its `editor` only where it
  is built editable (Linux); the tools are the Mac's, unchanged.
- A refusal is a reply `{"refused": kind}` with the Mac's kinds (`noSuchEvent`, `noSuchCalendar`,
  `calendarReadOnly`, `noDefaultCalendar`, `notOrganizer`, `calendarNoInvitations`), which the app
  turns into `EventStoreError`; any other failure is a helper error, as before.
- An event's id is its source's uid and the component's uid, `|`-separated (each with `%` and `|`
  escaped), plus the recurrence id of a detached occurrence. An occurrence is found as on the Mac:
  within `eventOccurrenceToleranceMs` of the start asked, searched over
  `eventOccurrenceSearchSpanMs`, through the same expansion `calendarEvents` reads, so a detached or
  RANGE-moved occurrence is the one shown.
- `thisOnly` stores a detached occurrence (the master's copy with its rules removed, under the
  occurrence's recurrence id); `thisAndFollowing` is EDS's THIS_AND_FUTURE, which ends the series and
  starts a new one under a new uid (found again by its start and title); on the first occurrence, and
  for `all`, the whole series changes. A series moved with `all` keeps its days apart and its
  length; one that repeats is written in the local zone with its TZID, so its wall time holds across
  daylight saving.
- Invitations need a calendar whose backend sends them (`save-schedules`) and knows the user's own
  address; otherwise adding or changing people is refused as `calendarNoInvitations` (a local
  calendar). An event is an invitation when it has attendees and an organizer other than the user;
  changing one is refused (`notOrganizer`), deleting it is not.
- A read of calendars, memos or tasks that a change interrupts is made again from the start, up to
  `calendarReadAttempts` times: EDS can tell a new view of a change saved just before it (a write of
  Voice's own included), and a read is still never a mix of versions. Writes are never repeated.
- A repeating event's times are stored in the local zone with its TZID set explicitly: libical 3.0
  labels a time converted to a zone as UTC, which stored 09:00 in Toronto as 09:00 UTC.
- Measured in the Ubuntu VM on EDS's local calendars, in UTC and in a daylight-saving zone
  (`tests/productivity.py`); a server-backed calendar (Google) by hand (TESTS.md).
