// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import { LocalDateTime } from "../../util/localDateTime.js";
import { Arguments, type ConnectorTool, ToolArgumentError } from "./connectorTool.js";

/** An event in the user's calendars, as the calendar tools read and create them. */
export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  calendar: string;
  location: string | null;
  notes: string | null;
}

/** An open reminder, as the reminders tools read and create them. */
export interface ReminderItem {
  title: string;
  list: string;
  /** When it is due, and whether that names a time of day. */
  due: Date | null;
  dueHasTime: boolean;
  notes: string | null;
}

/** The user's calendars and reminders (Apple Calendar and Reminders through `voice-macos` on a Mac,
 * ADR-DESK-024). Access is asked the first time a tool needs it; without it, a call throws saying
 * where to allow it, and the model tells the user. */
export interface EventStore {
  /** The events overlapping `start` to `end`, oldest first. */
  events(start: Date, end: Date): Promise<CalendarEvent[]>;
  /** Adds `event` to the default calendar (its `calendar` is ignored) and returns it as saved. */
  addEvent(event: CalendarEvent): Promise<CalendarEvent>;
  /** Open reminders, due before `dueBefore` when given. */
  openReminders(dueBefore: Date | null): Promise<ReminderItem[]>;
  /** Adds `reminder` to the default list (its `list` is ignored) and returns it as saved. */
  addReminder(reminder: ReminderItem): Promise<ReminderItem>;
}

/** Why Calendar or Reminders could not be used: the model reads the message, and tells the user. */
export type EventStoreErrorKind = "calendarNoAccess" | "remindersNoAccess" | "noDefaultCalendar" | "noDefaultList";

const eventStoreFailureMessages: Record<EventStoreErrorKind, string> = {
  calendarNoAccess: "TabMail Voice can't use Calendar. Allow it in System Settings › Privacy & Security › Calendars.",
  remindersNoAccess: "TabMail Voice can't use Reminders. Allow it in System Settings › Privacy & Security › Reminders.",
  noDefaultCalendar: "There is no default calendar to add the event to. Choose one in Calendar's settings.",
  noDefaultList: "There is no default Reminders list to add the reminder to. Choose one in Reminders' settings.",
};

export class EventStoreError extends Error {
  constructor(readonly kind: EventStoreErrorKind) {
    super(eventStoreFailureMessages[kind]);
    this.name = "EventStoreError";
  }

  static isKind(value: unknown): value is EventStoreErrorKind {
    return typeof value === "string" && Object.hasOwn(eventStoreFailureMessages, value);
  }
}

/** The Calendar and Reminders connectors' tools. */
export function calendarTools(store: EventStore, now: () => Date = () => new Date()): ConnectorTool[] {
  return [new CalendarReadTool(store, now), new CalendarEventCreateTool(store), new RemindersReadTool(store), new ReminderCreateTool(store)];
}

/** Reads the events in the user's calendars between two times (`calendar_read`), for "what's on
 * tomorrow" or "am I free Friday afternoon". */
export class CalendarReadTool implements ConnectorTool {
  readonly name = "calendar_read";
  readonly connector = "calendar";
  readonly progressLabel = "Checking your calendar";

  constructor(
    private readonly store: EventStore,
    private readonly now: () => Date,
  ) {}

  confirmation(): null {
    return null;
  }

  /** From the start of today, or `from_date`, to a day later, or `to_date` (a day: through its end). */
  async run(args: Record<string, unknown>): Promise<string> {
    const start = Arguments.localDate(args, "from_date")?.date ?? LocalDateTime.startOfDay(this.now());
    const end = Arguments.localEnd(args, "to_date") ?? LocalDateTime.addingDays(start, 1);
    if (end <= start) throw new ToolArgumentError("to_date is not after from_date.");
    if (end > LocalDateTime.addingDays(start, config.calendarReadMaxDays)) {
      throw new ToolArgumentError(`A calendar is read at most ${config.calendarReadMaxDays} days at a time: read a longer range in parts.`);
    }
    const range = `${LocalDateTime.describe(start)} to ${LocalDateTime.describe(end)}`;
    const events = await this.store.events(start, end);
    if (events.length === 0) return `No events from ${range}.`;
    return [`Events from ${range}:`, ...events.map((event) => `- ${describeEvent(event)}`)].join("\n");
  }
}

function describeEvent(event: CalendarEvent): string {
  const location = event.location === null || event.location === "" ? "" : `, at ${event.location}`;
  return `${event.title}: ${describeWhen(event)} (${event.calendar})${location}`;
}

/** When `event` is, as the model reads it: an all-day event by its first and last days. */
function describeWhen(event: CalendarEvent): string {
  if (!event.isAllDay) return `${LocalDateTime.describe(event.start)} to ${LocalDateTime.describe(event.end)}`;
  const first = LocalDateTime.describe(event.start, false);
  const last = LocalDateTime.describe(event.end, false);
  return first === last ? `${first}, all day` : `${first} to ${last}, all day`;
}

/** Adds an event to the user's default calendar (`calendar_event_create`), once they confirm what the
 * chat window shows: the question and the event come from the same `draft`. */
export class CalendarEventCreateTool implements ConnectorTool {
  readonly name = "calendar_event_create";
  readonly connector = "calendar";
  readonly progressLabel = "Adding the event";

  constructor(private readonly store: EventStore) {}

  /** Null only for arguments `run` rejects before adding anything. */
  confirmation(args: Record<string, unknown>): string | null {
    let event: CalendarEvent;
    try {
      event = CalendarEventCreateTool.draft(args);
    } catch {
      return null;
    }
    const lines = ["Add this event to your calendar?", event.title];
    if (event.isAllDay) {
      const first = LocalDateTime.spoken(event.start, false);
      const last = LocalDateTime.spoken(event.end, false);
      lines.push(first === last ? `${first}, all day` : `${first} to ${last}, all day`);
    } else {
      lines.push(`${LocalDateTime.spoken(event.start)} to ${LocalDateTime.spoken(event.end)}`);
    }
    if (event.location !== null) lines.push(event.location);
    // Every field the event is added with is shown: text the user never saw could carry anything.
    if (event.notes !== null) lines.push(event.notes);
    return lines.join("\n");
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const saved = await this.store.addEvent(CalendarEventCreateTool.draft(args));
    return `Added "${saved.title}" to the ${saved.calendar} calendar: ${describeWhen(saved)}.`;
  }

  /** The event the arguments describe. A day for `start_iso` (or `all_day`) makes it all day, through
   * the day `end_iso` names; without `end_iso`, a timed event lasts `calendarEventDefaultDuration`.
   * An all-day event's `end` is the start of its last day. */
  static draft(args: Record<string, unknown>): CalendarEvent {
    const title = Arguments.text(args, "title");
    if (title === null) throw ToolArgumentError.missing("title");
    const start = Arguments.localDate(args, "start_iso");
    if (start === null) throw ToolArgumentError.missing("start_iso");
    const end = Arguments.localDate(args, "end_iso");
    const isAllDay = typeof args.all_day === "boolean" ? args.all_day : !start.hasTime;
    const fields = { title, calendar: "", location: Arguments.text(args, "location"), notes: Arguments.text(args, "notes") };
    let event: CalendarEvent;
    if (isAllDay) {
      const first = LocalDateTime.startOfDay(start.date);
      event = { ...fields, start: first, end: end === null ? first : LocalDateTime.startOfDay(end.date), isAllDay: true };
    } else {
      event = { ...fields, start: start.date, end: end?.date ?? new Date(start.date.getTime() + config.calendarEventDefaultDuration), isAllDay: false };
    }
    if (event.end < event.start) throw new ToolArgumentError("end_iso is before start_iso.");
    return event;
  }
}

/** Reads the user's open reminders (`reminders_read`), soonest due first and those with no due date
 * last, for "what do I have to do this week". */
export class RemindersReadTool implements ConnectorTool {
  readonly name = "reminders_read";
  readonly connector = "reminders";
  readonly progressLabel = "Checking your reminders";

  constructor(private readonly store: EventStore) {}

  confirmation(): null {
    return null;
  }

  /** Due before `due_before` (a day: through its end) when given. */
  async run(args: Record<string, unknown>): Promise<string> {
    const dueBefore = Arguments.localEnd(args, "due_before");
    const reminders = [...(await this.store.openReminders(dueBefore))].sort((first, second) => {
      if (first.due === null || second.due === null) return (first.due === null ? 1 : 0) - (second.due === null ? 1 : 0);
      return first.due.getTime() - second.due.getTime();
    });
    const scope = dueBefore === null ? "" : ` due before ${LocalDateTime.describe(dueBefore)}`;
    if (reminders.length === 0) return `No open reminders${scope}.`;
    return [`Open reminders${scope}:`, ...reminders.map((reminder) => `- ${describeReminder(reminder)}`)].join("\n");
  }
}

function describeReminder(reminder: ReminderItem): string {
  const due = reminder.due === null ? "" : `, due ${LocalDateTime.describe(reminder.due, reminder.dueHasTime)}`;
  const notes = reminder.notes === null || reminder.notes === "" ? "" : `. Notes: ${reminder.notes}`;
  return `${reminder.title} (${reminder.list})${due}${notes}`;
}

/** Adds a reminder to the user's default Reminders list (`reminder_create`), once they confirm what
 * the chat window shows: the question and the reminder come from the same `draft`. */
export class ReminderCreateTool implements ConnectorTool {
  readonly name = "reminder_create";
  readonly connector = "reminders";
  readonly progressLabel = "Adding the reminder";

  constructor(private readonly store: EventStore) {}

  /** Null only for arguments `run` rejects before adding anything. */
  confirmation(args: Record<string, unknown>): string | null {
    let reminder: ReminderItem;
    try {
      reminder = ReminderCreateTool.draft(args);
    } catch {
      return null;
    }
    const lines = ["Add this reminder?", reminder.title];
    if (reminder.due !== null) lines.push(`Due ${LocalDateTime.spoken(reminder.due, reminder.dueHasTime)}`);
    // Every field the reminder is added with is shown: text the user never saw could carry anything.
    if (reminder.notes !== null) lines.push(reminder.notes);
    return lines.join("\n");
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const saved = await this.store.addReminder(ReminderCreateTool.draft(args));
    const due = saved.due === null ? "" : `, due ${LocalDateTime.describe(saved.due, saved.dueHasTime)}`;
    return `Added "${saved.title}" to the ${saved.list} list${due}.`;
  }

  static draft(args: Record<string, unknown>): ReminderItem {
    const title = Arguments.text(args, "title");
    if (title === null) throw ToolArgumentError.missing("title");
    const due = Arguments.localDate(args, "due_iso");
    return { title, list: "", due: due?.date ?? null, dueHasTime: due?.hasTime ?? false, notes: Arguments.text(args, "notes") };
  }
}
