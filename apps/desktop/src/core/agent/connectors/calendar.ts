// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import { LocalDateTime } from "../../util/localDateTime.js";
import { CancellationError } from "../../util/timeout.js";
import { Arguments, type ConnectorServices, type ConnectorTool, defineConnector, isJSONObject, ToolArgumentError } from "./contract.js";
import { isAddress } from "./email.js";

/** An event in the user's calendars, as the calendar tools read and create them. The fields after
 * `notes` are read and written only by a store with an `editor` (Apple Calendar); other stores leave
 * them out. */
export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  calendar: string;
  location: string | null;
  notes: string | null;
  /** What `EventEditor` knows the event by: of a repeating one, its series. */
  id?: string | null;
  /** Of an occurrence of a repeating event, its original start, which names it with `id`. */
  occurrence?: Date | null;
  calendarId?: string | null;
  availability?: Availability;
  attendees?: EventAttendee[];
  organizer?: EventAttendee | null;
  recurrence?: EventRecurrence | null;
  /** An occurrence of a repeating event changed on its own. */
  isDetached?: boolean;
  /** The user was invited to it by its organizer, someone else. */
  isInvitation?: boolean;
  /** The time zone its times, and its rule's days, are counted in; null for one that floats (all
   * day), counted in the Mac's. */
  timeZone?: string | null;
}

export type Availability = "busy" | "free";

/** Someone invited to an event, or its organizer. */
export interface EventAttendee {
  email: string;
  name: string | null;
  /** Their answer: "accepted", "declined", "tentative", "pending" or "unknown". */
  status?: string;
}

const frequencies = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
export type Frequency = (typeof frequencies)[number];

/** How an event repeats, as Calendar keeps it (EventKit's recurrence rule): weekdays numbered 1,
 * Sunday, to 7, each with the week of the month or year it falls in (0: every week). */
export interface EventRecurrence {
  frequency: Frequency;
  interval: number;
  count: number | null;
  until: Date | null;
  days: { weekday: number; week: number }[];
  monthDays: number[];
  months: number[];
  /** Which of the occurrences the rest selects in each period, -1 the last ("the last weekday":
   * Monday to Friday at -1). Read from Calendar, never written from the model's rule. */
  positions: number[];
  yearWeeks: number[];
  yearDays: number[];
}

/** A calendar events can be added to. */
export interface EventCalendar {
  id: string;
  title: string;
  /** The account it belongs to, as Calendar's sidebar heads it. */
  account: string;
  isDefault: boolean;
}

/** Which occurrences of a repeating event a change covers: the series, the one named, or the one
 * named and every one after it (split off as a series of its own). */
export type EventScope = "all" | "thisOnly" | "thisAndFollowing";

/** What a change to an event sets; an absent field is left as it is. */
export interface EventChanges {
  title?: string;
  /** The new start and end of the occurrence named: for the whole series, every one moves as much. */
  start?: Date;
  end?: Date;
  isAllDay?: boolean;
  /** "" removes it. */
  location?: string;
  notes?: string;
  availability?: Availability;
  /** Null: no longer repeats. */
  recurrence?: EventRecurrence | null;
  invite: EventAttendee[];
  /** Lowercased emails. */
  uninvite: string[];
  /** Occurrences dropped from the series, by their original starts. */
  exclude: Date[];
}

/** Single events read, changed and deleted by id, where the store can (Apple Calendar through
 * EventKit, ADR-DESK-060). Attendees are invited, updated and told of a cancellation by the
 * calendar's server (iCloud, Google, Exchange) once a change is saved. */
export interface EventEditor {
  /** The event `id` names; of a repeating one, the occurrence that started at `occurrence`, or the
   * first without it. */
  event(id: string, occurrence: Date | null): Promise<CalendarEvent>;
  /** The calendars events can be added to. */
  calendars(): Promise<EventCalendar[]>;
  edit(id: string, occurrence: Date | null, scope: EventScope, changes: EventChanges): Promise<CalendarEvent>;
  /** Deletes the event `id` names: every occurrence of a repeating one. */
  delete(id: string): Promise<void>;
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
  /** Fixed provider destination when writes do not use the user's default calendar. */
  readonly calendarWriteDestination?: string | undefined;
  /** Present where single events can be read, changed and deleted, and an added one can invite
   * people, repeat, go in a chosen calendar and show as free. */
  readonly editor?: EventEditor | undefined;
  /** The events overlapping `start` to `end`, oldest first. */
  events(start: Date, end: Date): Promise<CalendarEvent[]>;
  /** Adds `event` to the calendar its `calendarId` names, or the default one (its `calendar` is
   * ignored), and returns it as saved. */
  addEvent(event: CalendarEvent): Promise<CalendarEvent>;
  /** Open reminders, due before `dueBefore` when given. */
  openReminders(dueBefore: Date | null): Promise<ReminderItem[]>;
  /** Adds `reminder` to the default list (its `list` is ignored) and returns it as saved. */
  addReminder(reminder: ReminderItem): Promise<ReminderItem>;
}

/** Why Calendar or Reminders could not be used: the model reads the message, and tells the user. */
export type EventStoreErrorKind =
  | "calendarNoAccess"
  | "remindersNoAccess"
  | "noDefaultCalendar"
  | "noDefaultList"
  | "noSuchEvent"
  | "noSuchCalendar"
  | "calendarReadOnly"
  | "calendarNoInvitations"
  | "invitationsUnavailable"
  | "notOrganizer";

const eventStoreFailureMessages: Record<EventStoreErrorKind, string> = {
  calendarNoAccess: "TabMail Voice can't use Calendar. Allow it in System Settings › Privacy & Security › Calendars.",
  remindersNoAccess: "TabMail Voice can't use Reminders. Allow it in System Settings › Privacy & Security › Reminders.",
  noDefaultCalendar: "There is no default calendar to add the event to. Choose one in Calendar's settings.",
  noDefaultList: "There is no default Reminders list to add the reminder to. Choose one in Reminders' settings.",
  noSuchEvent: "There is no such event in the user's calendars: it may have been deleted or moved. Read the calendar again for its event_id and recurrence_id.",
  noSuchCalendar: "There is no calendar with that calendar_id. calendar_read lists the calendars events can be added to.",
  calendarReadOnly: "That calendar is read-only here (a subscribed or shared calendar): its events can't be added, changed or deleted.",
  calendarNoInvitations: "That calendar is on this computer only, so it can't send invitations. Use an iCloud, Google or Exchange calendar to invite people.",
  invitationsUnavailable: "This version of macOS doesn't let TabMail Voice invite people. The user can add them in Calendar.",
  notOrganizer: "The user was invited to this event by its organizer, so only the organizer can change it.",
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

export const calendarConnector = defineConnector({
  id: "calendar",
  order: 10,
  platforms: ["darwin", "win32", "linux"],
  displayName: "Calendar",
  settingsDescription: "Answers from your calendars, and adds, changes or deletes events you ask for once you confirm.",
  tools: ({ eventStore }: Pick<ConnectorServices, "eventStore">): ConnectorTool[] => {
    const tools: ConnectorTool[] = [new CalendarReadTool(eventStore, () => new Date()), new CalendarEventCreateTool(eventStore)];
    const editor = eventStore.editor;
    if (editor) tools.push(new CalendarEventReadTool(eventStore, editor), new CalendarEventEditTool(editor), new CalendarEventDeleteTool(editor));
    return tools;
  },
});

export const remindersConnector = defineConnector({
  id: "reminders",
  order: 20,
  platforms: ["darwin", "linux"],
  displayName: "Reminders",
  settingsDescription: "Answers from your reminders, and adds ones you ask for once you confirm.",
  tools: ({ eventStore }: Pick<ConnectorServices, "eventStore">): ConnectorTool[] => [new RemindersReadTool(eventStore), new ReminderCreateTool(eventStore)],
});

/** Reads the events in the user's calendars between two times (`calendar_read`), for "what's on
 * tomorrow" or "am I free Friday afternoon", `calendarReadPageSize` at a time. */
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

  /** From the start of today, or `from_date`, to a day later, or `to_date` (a day: through its end).
   * The first page also lists the calendars events can be added to, where the store has them. */
  async run(args: Record<string, unknown>): Promise<string> {
    const start = Arguments.localDate(args, "from_date")?.date ?? LocalDateTime.startOfDay(this.now());
    const end = Arguments.localEnd(args, "to_date") ?? LocalDateTime.addingDays(start, 1);
    if (end <= start) throw new ToolArgumentError("to_date is not after from_date.");
    if (end > LocalDateTime.addingDays(start, config.calendarReadMaxDays)) {
      throw new ToolArgumentError(`A calendar is read at most ${config.calendarReadMaxDays} days at a time: read a longer range in parts.`);
    }
    const page = args.page_index === undefined ? 1 : args.page_index;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) throw new ToolArgumentError("page_index is not a page number (1 or more).");
    const range = `${LocalDateTime.describe(start)} to ${LocalDateTime.describe(end)}`;
    const events = await this.store.events(start, end);
    const lines: string[] = [];
    if (events.length === 0) {
      if (page > 1) throw new ToolArgumentError("page_index is past the last page, 1.");
      lines.push(`No events from ${range}.`);
    } else {
      const pages = Math.ceil(events.length / config.calendarReadPageSize);
      if (page > pages) throw new ToolArgumentError(`page_index is past the last page, ${pages}.`);
      const shown = events.slice((page - 1) * config.calendarReadPageSize, page * config.calendarReadPageSize);
      lines.push(`Events from ${range}${pages > 1 ? `, page ${page} of ${pages}` : ""}:`, ...shown.map((event) => `- ${describeEvent(event)}`));
      if (page < pages) lines.push(`More events: call calendar_read again with page_index ${page + 1}.`);
    }
    if (this.store.editor && page === 1) {
      const calendars = await this.store.editor.calendars();
      lines.push("Calendars events can be added to (for calendar_id):", ...calendars.map((calendar) => `- ${describeCalendar(calendar)}`));
    }
    return lines.join("\n");
  }
}

function describeCalendar(calendar: EventCalendar): string {
  return `${calendar.title} (${calendar.account})${calendar.isDefault ? ", the default" : ""}: ${calendar.id}`;
}

/** One line of `calendar_read`: what the model needs to answer, and to name the event to the other
 * tools. */
function describeEvent(event: CalendarEvent): string {
  const location = event.location === null || event.location === "" ? "" : `, at ${event.location}`;
  const details = [...eventIDs(event)];
  if (event.recurrence) details.push(`repeats ${rrule(event.recurrence)}`);
  if (event.isDetached) details.push("this occurrence changed on its own");
  if (event.availability === "free") details.push("shown as free");
  if (event.isInvitation && event.organizer) details.push(`invited by ${describeAttendee(event.organizer)}`);
  if (event.attendees && event.attendees.length > 0) details.push(`attendees ${event.attendees.map(describeAttendee).join(", ")}`);
  return `${event.title}: ${describeWhen(event)} (${event.calendar})${location}${details.length === 0 ? "" : ` [${details.join("; ")}]`}`;
}

function eventIDs(event: CalendarEvent): string[] {
  const ids: string[] = [];
  if (event.id) ids.push(`event_id ${event.id}`);
  if (event.occurrence) ids.push(`recurrence_id ${LocalDateTime.iso(event.occurrence)}`);
  return ids;
}

function describeAttendee(attendee: EventAttendee): string {
  const who = attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email;
  return attendee.status === undefined || attendee.status === "unknown" ? who : `${who} (${attendee.status})`;
}

/** When `event` is, as the model reads it: an all-day event by its first and last days. */
function describeWhen(event: Pick<CalendarEvent, "start" | "end" | "isAllDay">): string {
  if (!event.isAllDay) return `${LocalDateTime.describe(event.start)} to ${LocalDateTime.describe(event.end)}`;
  const first = LocalDateTime.describe(event.start, false);
  const last = LocalDateTime.describe(event.end, false);
  return first === last ? `${first}, all day` : `${first} to ${last}, all day`;
}

/** When `event` is, as the user reads it in a question to confirm. */
function spokenWhen(event: Pick<CalendarEvent, "start" | "end" | "isAllDay">): string {
  if (!event.isAllDay) return `${LocalDateTime.spoken(event.start)} to ${LocalDateTime.spoken(event.end)}`;
  const first = LocalDateTime.spoken(event.start, false);
  const last = LocalDateTime.spoken(event.end, false);
  return first === last ? `${first}, all day` : `${first} to ${last}, all day`;
}

const weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinals: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last", [-2]: "second to last" };

/** `recurrence` as the model writes it: an iCalendar RRULE's fields. */
function rrule(recurrence: EventRecurrence): string {
  const parts = [`FREQ=${recurrence.frequency}`];
  if (recurrence.interval !== 1) parts.push(`INTERVAL=${recurrence.interval}`);
  if (recurrence.days.length > 0) parts.push(`BYDAY=${recurrence.days.map((day) => `${day.week === 0 ? "" : day.week}${weekdayCodes[day.weekday - 1]}`).join(",")}`);
  if (recurrence.monthDays.length > 0) parts.push(`BYMONTHDAY=${recurrence.monthDays.join(",")}`);
  if (recurrence.months.length > 0) parts.push(`BYMONTH=${recurrence.months.join(",")}`);
  if (recurrence.yearWeeks.length > 0) parts.push(`BYWEEKNO=${recurrence.yearWeeks.join(",")}`);
  if (recurrence.yearDays.length > 0) parts.push(`BYYEARDAY=${recurrence.yearDays.join(",")}`);
  if (recurrence.positions.length > 0) parts.push(`BYSETPOS=${recurrence.positions.join(",")}`);
  if (recurrence.count !== null) parts.push(`COUNT=${recurrence.count}`);
  if (recurrence.until !== null) parts.push(`UNTIL=${LocalDateTime.iso(recurrence.until)}`);
  return parts.join(";");
}

/** `recurrence` as the user reads it in a question to confirm. */
function spokenRecurrence(recurrence: EventRecurrence): string {
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[recurrence.frequency];
  let text = recurrence.interval === 1 ? `Repeats every ${unit}` : `Repeats every ${recurrence.interval} ${unit}s`;
  if (recurrence.days.length > 0) {
    text += ` on ${recurrence.days.map((day) => `${day.week === 0 ? "" : `the ${ordinals[day.week] ?? `week ${day.week}`} `}${weekdayNames[day.weekday - 1]}`).join(", ")}`;
  }
  if (recurrence.monthDays.length > 0) text += ` on day ${recurrence.monthDays.join(", ")}`;
  if (recurrence.months.length > 0) text += ` in ${recurrence.months.map((month) => monthNames[month - 1]).join(", ")}`;
  if (recurrence.count !== null) text += `, ${recurrence.count} times`;
  if (recurrence.until !== null) text += `, until ${LocalDateTime.spoken(recurrence.until, false)}`;
  return text;
}

/** The `recurrence` argument as the backend's tool definition describes it (an RRULE's fields), or
 * null for `{}`, which ends the repeating where that is allowed. */
function recurrenceArgument(value: unknown, start: Date): EventRecurrence | null {
  if (!isJSONObject(value)) throw new ToolArgumentError("recurrence is not an object.");
  if (Object.keys(value).length === 0) return null;
  const frequency = typeof value.freq === "string" ? value.freq.toUpperCase() : value.freq;
  if (!frequencies.includes(frequency as Frequency)) throw new ToolArgumentError("recurrence.freq must be DAILY, WEEKLY, MONTHLY or YEARLY.");
  const positive = (name: string, field: unknown): number | null => {
    if (field === undefined || field === null) return null;
    if (typeof field !== "number" || !Number.isInteger(field) || field < 1) throw new ToolArgumentError(`recurrence.${name} is not a whole number of 1 or more.`);
    return field;
  };
  const interval = positive("interval", value.interval) ?? 1;
  const count = positive("count", value.count);
  let until: Date | null = null;
  if (value.until !== undefined && value.until !== null) {
    const parsed = typeof value.until === "string" ? LocalDateTime.parse(value.until) : null;
    if (parsed === null) throw ToolArgumentError.notADate("recurrence.until");
    // A day repeats through its end.
    until = parsed.hasTime ? parsed.date : new Date(LocalDateTime.addingDays(parsed.date, 1).getTime() - 1);
    if (until < start) throw new ToolArgumentError("recurrence.until is before the event starts.");
  }
  if (count !== null && until !== null) throw new ToolArgumentError("recurrence takes count or until, not both.");
  const recurrence: EventRecurrence = {
    frequency: frequency as Frequency,
    interval,
    count,
    until,
    days: numbers(value.byDay, "byDay", (item) => {
      const match = typeof item === "string" ? /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/iu.exec(item.trim()) : null;
      const week = match?.[1] === undefined ? 0 : Number(match[1]);
      if (!match?.[2] || week === 0 && match[1] !== undefined || Math.abs(week) > 53) return null;
      return { weekday: weekdayCodes.indexOf(match[2].toUpperCase()) + 1, week };
    }),
    monthDays: numbers(value.byMonthDay, "byMonthDay", (item) => (Number.isInteger(item) && item !== 0 && Math.abs(item as number) <= 31 ? (item as number) : null)),
    months: numbers(value.byMonth, "byMonth", (item) => (Number.isInteger(item) && (item as number) >= 1 && (item as number) <= 12 ? (item as number) : null)),
    positions: [],
    yearWeeks: [],
    yearDays: [],
  };
  // What Calendar's rules can say: anything else it would drop or misread.
  if (recurrence.frequency === "DAILY" && recurrence.days.length > 0) throw new ToolArgumentError("recurrence.byDay needs WEEKLY, MONTHLY or YEARLY.");
  if (recurrence.frequency === "WEEKLY" && recurrence.days.some((day) => day.week !== 0)) throw new ToolArgumentError("A WEEKLY recurrence.byDay takes days alone, like MO, without a week number.");
  if (recurrence.monthDays.length > 0 && recurrence.frequency !== "MONTHLY") throw new ToolArgumentError("recurrence.byMonthDay needs MONTHLY.");
  if (recurrence.months.length > 0 && recurrence.frequency !== "YEARLY") throw new ToolArgumentError("recurrence.byMonth needs YEARLY.");
  return recurrence;
}

/** The list argument `name` of a recurrence, each item converted; throws on one that isn't valid. */
function numbers<T>(value: unknown, name: string, convert: (item: unknown) => T | null): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolArgumentError(`recurrence.${name} is not a list.`);
  return value.map((item: unknown) => {
    const converted = convert(item);
    if (converted === null) throw new ToolArgumentError(`recurrence.${name} has ${JSON.stringify(item)}, which is not valid there.`);
    return converted;
  });
}

/** The list argument `name` of people to invite, each with an email, once each. */
function attendeesArgument(args: Record<string, unknown>, name: string): EventAttendee[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolArgumentError(`${name} is not a list.`);
  const attendees: EventAttendee[] = [];
  for (const item of value as unknown[]) {
    const email = isJSONObject(item) ? Arguments.text(item, "email") : null;
    if (email === null || !isAddress(email)) throw new ToolArgumentError(`${name} has a person without an email address like name@example.com.`);
    if (attendees.some((attendee) => attendee.email.toLowerCase() === email.toLowerCase())) continue;
    attendees.push({ email, name: isJSONObject(item) ? Arguments.text(item, "name") : null });
  }
  return attendees;
}

function availabilityArgument(args: Record<string, unknown>): Availability | undefined {
  if (args.transparency === undefined || args.transparency === null) return undefined;
  if (args.transparency !== "busy" && args.transparency !== "free") throw new ToolArgumentError("transparency must be busy or free.");
  return args.transparency;
}

/** The lines of a question to confirm that say who is invited or removed: the calendar's server
 * emails them once it is saved. */
function invitationLines(invite: EventAttendee[], uninvite: string[] = []): string[] {
  const lines: string[] = [];
  if (invite.length > 0) lines.push(`Invite: ${invite.map(describeAttendee).join(", ")}`, "They are emailed an invitation.");
  if (uninvite.length > 0) lines.push(`Remove: ${uninvite.join(", ")}`, "They are emailed that they are no longer invited.");
  return lines;
}

/** Who `invite` asked for that the saved event does not have, as the model reads it: the
 * calendar's server keeps an invitation only if it can send it. */
function missingInvitees(invite: EventAttendee[], saved: CalendarEvent): string {
  const kept = new Set((saved.attendees ?? []).map((attendee) => attendee.email.toLowerCase()));
  const missing = invite.filter((attendee) => !kept.has(attendee.email.toLowerCase()));
  return missing.length === 0 ? "" : ` The calendar did not keep the invitation for ${missing.map((attendee) => attendee.email).join(", ")}: they were not invited.`;
}

/** What the model hears when the saved event does not show as free though it was asked to: a
 * calendar that can't show free time keeps it busy. */
function availabilityNotKept(asked: Availability | undefined, saved: CalendarEvent): string {
  return asked === "free" && saved.availability !== "free" ? " The calendar can't show events as free, so it shows as busy." : "";
}

/** Adds an event to the user's default calendar, or the one `calendar_id` names
 * (`calendar_event_create`), once they confirm what the chat window shows: the question and the
 * event come from the same `draft`. */
export class CalendarEventCreateTool implements ConnectorTool {
  readonly name = "calendar_event_create";
  readonly connector = "calendar";
  readonly progressLabel = "Adding the event";

  private readonly writeDestination: string | undefined;
  constructor(private readonly store: EventStore) {
    this.writeDestination = store.calendarWriteDestination;
  }

  /** Throws for arguments it can't add and for a calendar it can't find, so nothing is added
   * unasked: the controller tells the model why and runs nothing. */
  async confirmation(args: Record<string, unknown>): Promise<string> {
    const event = this.draft(args);
    let calendar: EventCalendar | undefined;
    if (event.calendarId) {
      calendar = (await this.store.editor?.calendars())?.find((candidate) => candidate.id === event.calendarId);
      if (!calendar) throw new EventStoreError("noSuchCalendar");
    }
    const lines = ["Add this event to your calendar?", event.title];
    if (this.writeDestination) lines.push(`Destination: ${this.writeDestination}`);
    if (calendar) lines.push(`Calendar: ${calendar.title} (${calendar.account})`);
    lines.push(spokenWhen(event));
    if (event.recurrence) lines.push(spokenRecurrence(event.recurrence));
    if (event.location !== null) lines.push(event.location);
    if (event.availability === "free") lines.push("Shown as free");
    // Every field the event is added with is shown: text the user never saw could carry anything.
    if (event.notes !== null) lines.push(event.notes);
    lines.push(...invitationLines(event.attendees ?? []));
    return lines.join("\n");
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const draft = this.draft(args);
    const saved = await this.store.addEvent(draft);
    const ids = eventIDs(saved);
    return `Added "${saved.title}" to ${this.writeDestination ?? `the ${saved.calendar} calendar`}: ${describeWhen(saved)}${ids.length === 0 ? "" : ` (${ids.join(", ")})`}.${missingInvitees(draft.attendees ?? [], saved)}${availabilityNotKept(draft.availability, saved)}`;
  }

  /** The event the arguments describe. A day for `start_iso` (or `all_day`) makes it all day, through
   * the day `end_iso` names; without `end_iso`, a timed event lasts `calendarEventDefaultDuration`.
   * An all-day event's `end` is the start of its last day. Invitations, repeating, a chosen calendar
   * and showing as free need the store's `editor`. */
  draft(args: Record<string, unknown>): CalendarEvent {
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
    const calendarId = Arguments.text(args, "calendar_id");
    const availability = availabilityArgument(args);
    const attendees = attendeesArgument(args, "attendees");
    const recurrence = args.recurrence === undefined || args.recurrence === null ? null : recurrenceArgument(args.recurrence, event.start);
    if (calendarId === null && availability === undefined && attendees.length === 0 && recurrence === null) return event;
    if (!this.store.editor) {
      throw new ToolArgumentError("The calendar on this computer can't invite people, repeat events, choose a calendar or show an event as free. Add it without calendar_id, transparency, attendees and recurrence, and tell the user what was left out.");
    }
    return { ...event, calendarId, availability: availability ?? "busy", attendees, recurrence };
  }
}

/** Reads one event in full (`calendar_event_read`): by `event_id` (and `recurrence_id` for one
 * occurrence), or by when it starts and its title. */
export class CalendarEventReadTool implements ConnectorTool {
  readonly name = "calendar_event_read";
  readonly connector = "calendar";
  readonly progressLabel = "Checking your calendar";

  constructor(
    private readonly store: EventStore,
    private readonly editor: EventEditor,
  ) {}

  confirmation(): null {
    return null;
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const id = Arguments.text(args, "event_id");
    if (id !== null) return describeEventInFull(await this.editor.event(id, Arguments.localDate(args, "recurrence_id")?.date ?? null));
    const start = Arguments.localDate(args, "start_iso");
    if (start === null) throw new ToolArgumentError("Give event_id, or start_iso (and title) to find the event by when it starts.");
    const title = Arguments.text(args, "title");
    const tolerance = config.calendarEventStartTolerance;
    const candidates = await this.store.events(start.date, new Date(start.date.getTime() + tolerance));
    const found = candidates.filter(
      (event) => Math.abs(event.start.getTime() - start.date.getTime()) < tolerance && (title === null || event.title.toLowerCase() === title.toLowerCase()),
    );
    if (found.length === 0) return `No event starts at ${LocalDateTime.describe(start.date, start.hasTime)}${title === null ? "" : ` titled "${title}"`}.`;
    return found.map(describeEventInFull).join("\n\n");
  }
}

/** Every field of `event`, as `calendar_event_read` gives it. */
function describeEventInFull(event: CalendarEvent): string {
  const lines = [event.title, `When: ${describeWhen(event)}`, `Calendar: ${event.calendar}${event.calendarId ? ` (calendar_id ${event.calendarId})` : ""}`];
  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.recurrence) lines.push(`Repeats: ${rrule(event.recurrence)}`);
  if (event.isDetached) lines.push("This occurrence was changed on its own.");
  lines.push(`Shown as: ${event.availability ?? "busy"}`);
  if (event.organizer) lines.push(`Organizer: ${describeAttendee(event.organizer)}${event.isInvitation ? " (the user was invited, so only the organizer can change it)" : ""}`);
  if (event.attendees && event.attendees.length > 0) lines.push(`Attendees: ${event.attendees.map(describeAttendee).join(", ")}`);
  if (event.notes) lines.push(`Notes: ${event.notes}`);
  lines.push(...eventIDs(event));
  return lines.join("\n");
}

/** What `calendar_event_edit`'s arguments ask of an event, as the user confirms it and the store
 * carries it out. */
interface EditPlan {
  id: string;
  occurrence: Date | null;
  scope: EventScope;
  current: CalendarEvent;
  changes: EventChanges;
}

const scopes: Record<string, EventScope> = { all: "all", this_only: "thisOnly", this_and_following: "thisAndFollowing" };

/** Changes an event (`calendar_event_edit`) once the user confirms what the chat window shows: the
 * question and the change come from the same `plan`, over the event as it is now. Only the fields
 * given change; a new start alone keeps the event's length, as does a new end alone. */
export class CalendarEventEditTool implements ConnectorTool {
  readonly name = "calendar_event_edit";
  readonly connector = "calendar";
  readonly progressLabel = "Changing the event";

  constructor(private readonly editor: EventEditor) {}

  /** Throws for a change it can't make or an event it can't read, so nothing is changed unasked. */
  async confirmation(args: Record<string, unknown>): Promise<string> {
    const { current, changes, scope, occurrence } = await this.plan(args);
    const lines = ["Change this event?", current.title, spokenWhen(current)];
    if (current.isDetached) lines.push("Only this occurrence: it was changed on its own");
    else if (current.recurrence && occurrence !== null && scope === "thisOnly") lines.push(`Only the occurrence on ${LocalDateTime.spoken(occurrence, false)}`);
    else if (current.recurrence && occurrence !== null && scope === "thisAndFollowing") lines.push(`The occurrence on ${LocalDateTime.spoken(occurrence, false)} and every one after it`);
    else if (current.recurrence) lines.push("Every occurrence");
    if (changes.title !== undefined) lines.push(`New title: ${changes.title}`);
    if (changes.start !== undefined && changes.end !== undefined) {
      lines.push(`New time: ${spokenWhen({ start: changes.start, end: changes.end, isAllDay: changes.isAllDay ?? current.isAllDay })}`);
      // Calendar keeps a deleted occurrence by its old time: moved, the series has it again.
      if (current.recurrence && scope !== "thisOnly") lines.push("Every occurrence covered moves by as much, and any deleted from the series come back.");
    }
    // Every field the event is changed with is shown: text the user never saw could carry anything.
    if (changes.location !== undefined) lines.push(changes.location === "" ? "Remove the location" : `New location: ${changes.location}`);
    if (changes.notes !== undefined) lines.push(changes.notes === "" ? "Remove the notes" : `New notes: ${changes.notes}`);
    if (changes.availability !== undefined) lines.push(`Shown as ${changes.availability}`);
    if (changes.recurrence !== undefined) lines.push(changes.recurrence === null ? "Stops repeating" : spokenRecurrence(changes.recurrence));
    if (changes.exclude.length > 0) lines.push(`Delete the occurrences on: ${changes.exclude.map((date) => LocalDateTime.spoken(date, !current.isAllDay)).join("; ")}`);
    lines.push(...invitationLines(changes.invite, changes.uninvite));
    const others = (current.attendees ?? []).filter((attendee) => attendee.email.toLowerCase() !== current.organizer?.email.toLowerCase());
    if (others.length > 0) lines.push("Its attendees are emailed the change.");
    return lines.join("\n");
  }

  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const { id, occurrence, scope, changes } = await this.plan(args);
    // Canceled while the event was read again: the change the user confirmed is no longer wanted.
    if (signal.aborted) throw new CancellationError();
    const saved = await this.editor.edit(id, occurrence, scope, changes);
    return `Changed "${saved.title}": ${describeWhen(saved)} (${eventIDs(saved).join(", ")}).${missingInvitees(changes.invite, saved)}${availabilityNotKept(changes.availability, saved)}`;
  }

  /** The change the arguments ask for, over the event as it is now; throws for one it can't make. */
  async plan(args: Record<string, unknown>): Promise<EditPlan> {
    const id = Arguments.text(args, "event_id");
    if (id === null) throw ToolArgumentError.missing("event_id");
    const occurrence = Arguments.localDate(args, "recurrence_id")?.date ?? null;
    const rawScope = args.edit_scope ?? (occurrence === null ? "all" : "this_only");
    const named = typeof rawScope === "string" ? scopes[rawScope] : undefined;
    if (named === undefined) throw new ToolArgumentError("edit_scope must be all, this_only or this_and_following.");
    const current = await this.editor.event(id, occurrence);
    // An occurrence changed on its own has an id of its own, which names it alone.
    if (current.isDetached && ((args.edit_scope !== undefined && named !== "thisOnly") || (args.recurrence !== undefined && args.recurrence !== null))) {
      throw new ToolArgumentError("This occurrence was changed on its own, so its event_id changes it alone. To change the series, use the event_id and recurrence_id of another occurrence.");
    }
    // Changed alone, whether or not a recurrence_id names it: Calendar saves it over every later one otherwise.
    const repeats = Boolean(current.recurrence) && !current.isDetached;
    const scope = current.isDetached ? "thisOnly" : repeats ? named : "all";
    if (repeats && scope !== "all" && occurrence === null) throw new ToolArgumentError(`edit_scope ${String(rawScope)} needs recurrence_id: the occurrence it starts from.`);

    const changes: EventChanges = { invite: attendeesArgument(args, "add_attendees"), uninvite: [], exclude: [] };
    const title = Arguments.text(args, "title");
    if (title !== null) changes.title = title;
    const times = editedTimes(args, current);
    if (times !== null) {
      // Moving a series needs the occurrence the new times are for: every one moves by as much.
      if (repeats && occurrence === null) throw new ToolArgumentError("A repeating event's new start_iso or end_iso needs recurrence_id: the occurrence those times are for.");
      Object.assign(changes, times);
    }
    for (const field of ["location", "notes"] as const) {
      const value = args[field];
      if (typeof value === "string") changes[field] = value.trim();
    }
    const availability = availabilityArgument(args);
    if (availability !== undefined) changes.availability = availability;
    changes.uninvite = removedAttendees(args, current);
    if (args.recurrence !== undefined && args.recurrence !== null) {
      if (scope === "thisOnly") throw new ToolArgumentError("One occurrence can't repeat on its own: give edit_scope all or this_and_following to change how the event repeats.");
      changes.recurrence = recurrenceArgument(args.recurrence, changes.start ?? current.start);
    }
    // A rule that picks its days would no longer match a series moved to another day, counted where
    // Calendar counts the rule's days: in the event's zone, which can be another than the Mac's.
    const zone = current.timeZone ?? undefined;
    if (current.recurrence && scope !== "thisOnly" && changes.start !== undefined && changes.recurrence === undefined && picksDays(current.recurrence) && dayIn(changes.start, zone) !== dayIn(current.start, zone)) {
      throw new ToolArgumentError(`This series repeats ${rrule(current.recurrence)}: to move it to another day, give recurrence with the days it moves to.`);
    }
    changes.exclude = excludedOccurrences(args, repeats, occurrence);
    // Moved, the series has its deleted occurrences again: the ones named would come straight back.
    if (changes.exclude.length > 0 && times !== null && scope !== "thisOnly") {
      throw new ToolArgumentError("exdates_add can't go with new times for the series, which bring deleted occurrences back: move it first, then read it and delete the occurrences at their new times.");
    }
    const asked = changes.title ?? changes.start ?? changes.location ?? changes.notes ?? changes.availability;
    if (asked === undefined && changes.recurrence === undefined && changes.invite.length === 0 && changes.uninvite.length === 0 && changes.exclude.length === 0) {
      throw new ToolArgumentError("Nothing to change: give the fields to change.");
    }
    return { id, occurrence, scope, current, changes };
  }
}

/** `date`'s day (2099-01-15) in the time zone `zone`, or the Mac's. */
function dayIn(date: Date, zone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Whether `rule` names the days it falls on (BYDAY and the like), rather than repeating its start's. */
function picksDays(rule: EventRecurrence): boolean {
  return [rule.days, rule.monthDays, rule.months, rule.positions, rule.yearWeeks, rule.yearDays].some((part) => part.length > 0);
}

/** The new start, end and all-day of an edit, or null when it changes none of them. A new start
 * alone keeps the event's length, and so does a new end alone; changed between all day and timed,
 * the event lasts a day, or `calendarEventDefaultDuration`. */
function editedTimes(args: Record<string, unknown>, current: CalendarEvent): { start: Date; end: Date; isAllDay: boolean } | null {
  const start = Arguments.localDate(args, "start_iso");
  const end = Arguments.localDate(args, "end_iso");
  const allDay = typeof args.all_day === "boolean" ? args.all_day : undefined;
  if (start === null && end === null && allDay === undefined) return null;
  const isAllDay = allDay ?? (start ? !start.hasTime : end ? !end.hasTime : current.isAllDay);
  const sameKind = isAllDay === current.isAllDay;
  let times: { start: Date; end: Date };
  if (isAllDay) {
    const first = LocalDateTime.startOfDay(current.start);
    const days = sameKind ? Math.round((LocalDateTime.startOfDay(current.end).getTime() - first.getTime()) / (24 * 60 * 60 * 1_000)) : 0;
    if (start) {
      const newFirst = LocalDateTime.startOfDay(start.date);
      times = { start: newFirst, end: end ? LocalDateTime.startOfDay(end.date) : LocalDateTime.addingDays(newFirst, days) };
    } else if (end) {
      const last = LocalDateTime.startOfDay(end.date);
      times = { start: LocalDateTime.addingDays(last, -days), end: last };
    } else {
      times = { start: first, end: LocalDateTime.addingDays(first, days) };
    }
  } else {
    const length = sameKind ? current.end.getTime() - current.start.getTime() : config.calendarEventDefaultDuration;
    if (start) times = { start: start.date, end: end ? end.date : new Date(start.date.getTime() + length) };
    else if (end) times = { start: new Date(end.date.getTime() - length), end: end.date };
    else times = { start: current.start, end: new Date(current.start.getTime() + length) };
  }
  if (times.end < times.start) throw new ToolArgumentError("end_iso is before start_iso.");
  return { ...times, isAllDay };
}

/** The emails `remove_attendees` names, lowercased; "*" names every attendee but the organizer. */
function removedAttendees(args: Record<string, unknown>, current: CalendarEvent): string[] {
  const value = args.remove_attendees;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolArgumentError("remove_attendees is not a list.");
  const organizer = current.organizer?.email.toLowerCase();
  const present = (current.attendees ?? []).map((attendee) => attendee.email.toLowerCase()).filter((email) => email !== organizer);
  const removed = new Set<string>();
  for (const item of value as unknown[]) {
    const email = isJSONObject(item) ? Arguments.text(item, "email")?.toLowerCase() : undefined;
    if (email === "*") present.forEach((attendee) => removed.add(attendee));
    else if (email && present.includes(email)) removed.add(email);
    else if (!email) throw new ToolArgumentError("remove_attendees has an item without an email.");
  }
  return [...removed];
}

/** The occurrences `exdates_add` drops from a repeating event, by their starts. */
function excludedOccurrences(args: Record<string, unknown>, repeats: boolean, occurrence: Date | null): Date[] {
  const value = args.exdates_add;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolArgumentError("exdates_add is not a list.");
  if (value.length === 0) return [];
  if (!repeats) throw new ToolArgumentError("exdates_add is for a repeating event: delete a single event with calendar_event_delete.");
  return (value as unknown[]).map((item) => {
    const parsed = typeof item === "string" ? LocalDateTime.parse(item) : null;
    if (parsed === null) throw ToolArgumentError.notADate("exdates_add");
    if (occurrence !== null && parsed.date.getTime() === occurrence.getTime()) throw new ToolArgumentError("exdates_add has the occurrence being changed: change it, or drop it alone.");
    return parsed.date;
  });
}

/** Deletes an event (`calendar_event_delete`), every occurrence of a repeating one, once the user
 * confirms; its attendees are emailed the cancellation. One occurrence is dropped with
 * `calendar_event_edit`'s `exdates_add`, or by its own event_id when it was changed on its own. */
export class CalendarEventDeleteTool implements ConnectorTool {
  readonly name = "calendar_event_delete";
  readonly connector = "calendar";
  readonly progressLabel = "Deleting the event";

  constructor(private readonly editor: EventEditor) {}

  /** Throws for an event it can't read, so nothing is deleted unasked. */
  async confirmation(args: Record<string, unknown>): Promise<string> {
    const event = await this.target(args);
    const lines = ["Delete this event?", event.title, spokenWhen(event)];
    if (event.recurrence && !event.isDetached) lines.push("Every occurrence is deleted.");
    if (event.isDetached) lines.push("Only this occurrence is deleted: it was changed on its own.");
    if (event.isInvitation) lines.push("You were invited to it: it is removed from your calendar.");
    else if ((event.attendees ?? []).some((attendee) => attendee.email.toLowerCase() !== event.organizer?.email.toLowerCase())) lines.push("Its attendees are emailed a cancellation.");
    return lines.join("\n");
  }

  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const event = await this.target(args);
    // Canceled while the event was read again: the deletion the user confirmed is no longer wanted.
    if (signal.aborted) throw new CancellationError();
    await this.editor.delete(event.id ?? "");
    return `Deleted "${event.title}"${event.recurrence && !event.isDetached ? ", every occurrence" : ""}.`;
  }

  private async target(args: Record<string, unknown>): Promise<CalendarEvent> {
    const id = Arguments.text(args, "event_id");
    if (id === null) throw ToolArgumentError.missing("event_id");
    return { ...(await this.editor.event(id, null)), id };
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
