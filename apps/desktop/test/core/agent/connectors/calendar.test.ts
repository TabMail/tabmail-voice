// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A zone that is neither UTC nor, likely, this computer's, with no daylight saving: the tools read and
// write every date in the local zone. Set before any date is made (each test file runs in its own
// process).
process.env.TZ = "Asia/Kolkata";

import { beforeEach, describe, expect, test } from "vitest";
import {
  type CalendarEvent,
  CalendarEventCreateTool,
  CalendarEventDeleteTool,
  CalendarEventEditTool,
  CalendarEventReadTool,
  CalendarReadTool,
  calendarConnector,
  type EventCalendar,
  type EventChanges,
  type EventEditor,
  type EventRecurrence,
  type EventScope,
  type EventStore,
  EventStoreError,
  type ReminderItem,
  ReminderCreateTool,
  remindersConnector,
  RemindersReadTool,
} from "../../../../src/core/agent/connectors/calendar.js";
import { ToolArgumentError } from "../../../../src/core/agent/connectors/contract.js";
import * as config from "../../../../src/core/config.js";
import { LocalDateTime } from "../../../../src/core/util/localDateTime.js";
import { CancellationError } from "../../../../src/core/util/timeout.js";

/** Calendar and Reminders as the Answer prompt's tools, against a fake store: what the model asks for
 * in the backend's date forms, what the user is asked to confirm, and what the model reads back
 * (from the Swift `EventKitToolsTests`). */

/** Calendar and Reminders in memory, recording what the tools asked of them. */
class FakeEventStore implements EventStore {
  storedEvents: CalendarEvent[] = [];
  reminders: ReminderItem[] = [];
  failure: Error | null = null;
  readonly readRanges: [Date, Date][] = [];
  readonly dueBefore: (Date | null)[] = [];
  readonly added: CalendarEvent[] = [];
  readonly addedReminders: ReminderItem[] = [];

  async events(start: Date, end: Date): Promise<CalendarEvent[]> {
    if (this.failure) throw this.failure;
    this.readRanges.push([start, end]);
    return this.storedEvents;
  }

  async addEvent(event: CalendarEvent): Promise<CalendarEvent> {
    if (this.failure) throw this.failure;
    this.added.push(event);
    return { ...event, calendar: "Work" };
  }

  async openReminders(dueBefore: Date | null): Promise<ReminderItem[]> {
    if (this.failure) throw this.failure;
    this.dueBefore.push(dueBefore);
    return this.reminders;
  }

  async addReminder(reminder: ReminderItem): Promise<ReminderItem> {
    if (this.failure) throw this.failure;
    this.addedReminders.push(reminder);
    return { ...reminder, list: "Reminders" };
  }
}

/** A week from today, at 00:00. */
function weekAhead(): Date {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
}

const day = weekAhead();

/** `hour`:`minute` on `day`, `dayOffset` days on. */
function at(hour: number, minute = 0, dayOffset = 0): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, hour, minute);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `date` as the backend's tools write it: `2025-01-15T14:00:00`, or `2025-01-15` for a day. */
function iso(date: Date, time = true): string {
  const dayPart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return time ? `${dayPart}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : dayPart;
}

const describeDate = (date: Date, time = true) => LocalDateTime.describe(date, time);

function event(title: string, start: Date, end: Date, options: { allDay?: boolean; location?: string } = {}): CalendarEvent {
  return { title, start, end, isAllDay: options.allDay ?? false, calendar: "Work", location: options.location ?? null, notes: null };
}

let store: FakeEventStore;
beforeEach(() => {
  store = new FakeEventStore();
});

describe("dates", () => {
  /** The backend's date forms parse in the local zone, and say whether they name a time. */
  test("the backend's date forms parse in the local zone", () => {
    expect(new Date().getTimezoneOffset()).toBe(-330);
    expect(LocalDateTime.parse(iso(at(12)))).toEqual({ date: at(12), hasTime: true });
    expect(LocalDateTime.parse(iso(at(9, 30)).slice(0, -3))).toEqual({ date: at(9, 30), hasTime: true });
    expect(LocalDateTime.parse(` ${iso(day, false)} `)).toEqual({ date: day, hasTime: false });
  });

  test.each(["friday", "", "2099-13-15", "2099-02-30", "2099-01-15T24:00:00", "2099-01-15T10:60", "2099-01-15T10:00:60", "2099-01-15T14:00:00Z", "15/01/2099", "2099-1-15", "0025-01-15"])(
    "%j is not a date",
    (text) => {
      expect(LocalDateTime.parse(text)).toBeNull();
    },
  );

  /** What the model reads: the weekday, the day, and the time on a 24-hour clock. */
  test("the model reads a date with its weekday", () => {
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at(9, 5).getDay()];
    expect(LocalDateTime.describe(at(9, 5))).toBe(`${weekday} ${iso(day, false)} 09:05`);
    expect(LocalDateTime.describe(at(21, 30), false)).toBe(`${weekday} ${iso(day, false)}`);
  });

  /** What the user reads: the locale's full date, with the time only when asked. */
  test("the user reads a date in their locale", () => {
    expect(LocalDateTime.spoken(at(14))).toBe(at(14).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }));
    expect(LocalDateTime.spoken(at(14), false)).toBe(at(14).toLocaleString(undefined, { dateStyle: "full" }));
  });
});

describe("calendar_read", () => {
  /** The events between the two times, oldest first, each with its time, calendar and place (none when
   * blank); a day for `to_date` reads through the end of it. */
  test("the calendar is read between two times", async () => {
    store.storedEvents = [event("Launch review", at(10), at(11), { location: "Room 4" }), event("Offsite", day, day, { allDay: true, location: "" }), event("Conference", day, at(0, 0, 2), { allDay: true })];
    const tool = new CalendarReadTool(store, () => new Date());

    const result = await tool.run({ from_date: iso(at(8)), to_date: iso(day, false) });

    expect(store.readRanges).toEqual([[at(8), at(0, 0, 1)]]);
    expect(result).toBe(
      [
        `Events from ${describeDate(at(8))} to ${describeDate(at(0, 0, 1))}:`,
        `- Launch review: ${describeDate(at(10))} to ${describeDate(at(11))} (Work), at Room 4`,
        `- Offsite: ${describeDate(day, false)}, all day (Work)`,
        `- Conference: ${describeDate(day, false)} to ${describeDate(at(0, 0, 2), false)}, all day (Work)`,
      ].join("\n"),
    );
  });

  /** With no range, today is read; with only a start, the day from it. */
  test("without a range, today is read", async () => {
    const tool = new CalendarReadTool(store, () => at(15));

    const today = await tool.run({});
    await tool.run({ from_date: iso(at(9)) });

    expect(store.readRanges).toEqual([
      [day, at(0, 0, 1)],
      [at(9), at(9, 0, 1)],
    ]);
    expect(today).toBe(`No events from ${describeDate(day)} to ${describeDate(at(0, 0, 1))}.`);
  });

  /** A date the tool can't read, or a range that ends before it starts, reads nothing and tells the
   * model. */
  test.each<[Record<string, unknown>, string]>([
    [{ from_date: "friday" }, "from_date is not a date and time like 2025-01-15T14:00:00, or a day like 2025-01-15."],
    [{ to_date: "tomorrow" }, "to_date is not a date and time like 2025-01-15T14:00:00, or a day like 2025-01-15."],
    [{ from_date: "2099-01-15T12:00:00", to_date: "2099-01-15T09:00:00" }, "to_date is not after from_date."],
    [{ from_date: "2099-01-15T12:00:00", to_date: "2099-01-15T12:00:00" }, "to_date is not after from_date."],
  ])("%j is reported", async (args, message) => {
    const tool = new CalendarReadTool(store, () => new Date());

    await expect(tool.run(args)).rejects.toEqual(new ToolArgumentError(message));
    expect(store.readRanges).toEqual([]);
  });

  /** EventKit reads at most four years at once, dropping the rest unsaid: a longer range reads
   * nothing and the model is told to read it in parts; exactly the longest range is read whole. */
  test("a range longer than EventKit reads is refused", async () => {
    const tool = new CalendarReadTool(store, () => new Date());
    const longest = at(0, 0, config.calendarReadMaxDays);

    await expect(tool.run({ from_date: iso(day, false), to_date: iso(at(0, 1, config.calendarReadMaxDays)) })).rejects.toEqual(
      new ToolArgumentError(`A calendar is read at most ${config.calendarReadMaxDays} days at a time: read a longer range in parts.`),
    );
    expect(store.readRanges).toEqual([]);

    await tool.run({ from_date: iso(day, false), to_date: iso(longest) });
    expect(store.readRanges).toEqual([[day, longest]]);
  });

  /** Without access to Calendar, the tool fails saying where to allow it, which the model tells the
   * user. */
  test("no access says where to allow it", async () => {
    store.failure = new EventStoreError("calendarNoAccess");
    const tool = new CalendarReadTool(store, () => new Date());

    await expect(tool.run({})).rejects.toBe(store.failure);
    expect(new EventStoreError("calendarNoAccess").message).toContain("System Settings › Privacy & Security › Calendars");
    expect(new EventStoreError("remindersNoAccess").message).toContain("System Settings › Privacy & Security › Reminders");
    expect(new EventStoreError("noDefaultCalendar").message).toContain("Calendar's settings");
    expect(new EventStoreError("noDefaultList").message).toContain("Reminders' settings");
  });
});

describe("calendar_event_create", () => {
  /** The user is asked about the event as it will be added, every field it is added with shown, and it
   * is added as asked: with no end, it lasts the default hour. */
  test("an event is added as the user confirmed it", async () => {
    const tool = new CalendarEventCreateTool(store);
    const args = { title: " Launch review ", start_iso: iso(at(10)), location: "Room 4", notes: "Bring https://example.com/deck" };
    const end = new Date(at(10).getTime() + config.calendarEventDefaultDuration);

    const question = await tool.confirmation(args);
    const result = await tool.run(args);

    expect(question).toBe(["Add this event to your calendar?", "Launch review", `${LocalDateTime.spoken(at(10))} to ${LocalDateTime.spoken(end)}`, "Room 4", "Bring https://example.com/deck"].join("\n"));
    expect(store.added).toEqual([{ title: "Launch review", start: at(10), end, isAllDay: false, calendar: "", location: "Room 4", notes: "Bring https://example.com/deck" }]);
    expect(result).toBe(`Added "Launch review" to the Work calendar: ${describeDate(at(10))} to ${describeDate(end)}.`);
  });

  /** A day for the start makes an all-day event, through the day `end_iso` names (its time ignored); `all_day` makes one
   * of a timed start; `end_iso` sets a timed event's end. */
  test("a day makes an all-day event", async () => {
    expect(new CalendarEventCreateTool(store).draft({ title: "Offsite", start_iso: iso(day, false), end_iso: iso(at(0, 0, 2), false) })).toMatchObject({ isAllDay: true, start: day, end: at(0, 0, 2) });
    expect(new CalendarEventCreateTool(store).draft({ title: "Holiday", start_iso: iso(at(9)), all_day: true })).toMatchObject({ isAllDay: true, start: day, end: day });
    expect(new CalendarEventCreateTool(store).draft({ title: "Offsite", start_iso: iso(day, false), end_iso: iso(at(15, 0, 2)) })).toMatchObject({ isAllDay: true, start: day, end: at(0, 0, 2) });
    expect(new CalendarEventCreateTool(store).draft({ title: "Call", start_iso: iso(at(9)), end_iso: iso(at(9, 30)) })).toMatchObject({ isAllDay: false, start: at(9), end: at(9, 30) });
    expect(new CalendarEventCreateTool(store).draft({ title: "Call", start_iso: iso(day, false), all_day: false })).toMatchObject({ isAllDay: false, start: day });

    const tool = new CalendarEventCreateTool(store);
    const first = LocalDateTime.spoken(day, false);
    expect(await tool.confirmation({ title: "Offsite", start_iso: iso(day, false) })).toBe(`Add this event to your calendar?\nOffsite\n${first}, all day`);
    expect(await tool.confirmation({ title: "Offsite", start_iso: iso(day, false), end_iso: iso(at(0, 0, 2), false) })).toBe(
      `Add this event to your calendar?\nOffsite\n${first} to ${LocalDateTime.spoken(at(0, 0, 2), false)}, all day`,
    );
    expect(await tool.run({ title: "Offsite", start_iso: iso(day, false) })).toBe(`Added "Offsite" to the Work calendar: ${describeDate(day, false)}, all day.`);
    expect(await tool.run({ title: "Offsite", start_iso: iso(day, false), end_iso: iso(at(0, 0, 2), false) })).toBe(
      `Added "Offsite" to the Work calendar: ${describeDate(day, false)} to ${describeDate(at(0, 0, 2), false)}, all day.`,
    );
  });

  /** Arguments it can't use are neither asked about nor added: the model is told why. */
  test.each<Record<string, unknown>>([
    { start_iso: "2099-01-15T10:00:00" },
    { title: "  ", start_iso: "2099-01-15T10:00:00" },
    { title: 7, start_iso: "2099-01-15T10:00:00" },
    { title: "Launch review" },
    { title: "Launch review", start_iso: "next friday" },
    { title: "Launch review", start_iso: "2099-01-15T10:00:00", end_iso: "later" },
    { title: "Launch review", start_iso: "2099-01-15T10:00:00", end_iso: "2099-01-15T09:00:00" },
    { title: "Offsite", start_iso: "2099-01-15", end_iso: "2099-01-14" },
  ])("%j is neither asked about nor added", async (args) => {
    const tool = new CalendarEventCreateTool(store);

    await expect(tool.confirmation(args)).rejects.toThrow();
    await expect(tool.run(args)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(store.added).toEqual([]);
  });
});

describe("reminders_read", () => {
  /** Open reminders, soonest due first and those with no due date last; a day for `due_before` reads
   * through the end of it. */
  test("open reminders are read soonest first", async () => {
    store.reminders = [
      { title: "Water the plants", list: "Home", due: null, dueHasTime: false, notes: null },
      { title: "Send the deck", list: "Work", due: at(17), dueHasTime: true, notes: "the short one" },
      { title: "Pay the bill", list: "Home", due: null, dueHasTime: false, notes: "" },
      { title: "Book flights", list: "Travel", due: at(0, 0, -1), dueHasTime: false, notes: null },
    ];
    const tool = new RemindersReadTool(store);

    const result = await tool.run({ due_before: iso(day, false) });

    expect(store.dueBefore).toEqual([at(0, 0, 1)]);
    expect(result).toBe(
      [
        `Open reminders due before ${describeDate(at(0, 0, 1))}:`,
        `- Book flights (Travel), due ${describeDate(at(0, 0, -1), false)}`,
        `- Send the deck (Work), due ${describeDate(at(17))}. Notes: the short one`,
        "- Water the plants (Home)",
        "- Pay the bill (Home)",
      ].join("\n"),
    );
  });

  test("no open reminders says so", async () => {
    const tool = new RemindersReadTool(store);

    expect(await tool.run({})).toBe("No open reminders.");
    expect(await tool.run({ due_before: iso(at(12)) })).toBe(`No open reminders due before ${describeDate(at(12))}.`);
    expect(store.dueBefore).toEqual([null, at(12)]);
    await expect(tool.run({ due_before: "soon" })).rejects.toBeInstanceOf(ToolArgumentError);
  });
});

describe("reminder_create", () => {
  /** The user is asked about the reminder as it will be added, every field it is added with shown (its
   * notes too), and it is added as asked; a day for `due_iso` is due that day, with no time. */
  test("a reminder is added as the user confirmed it", async () => {
    const tool = new ReminderCreateTool(store);
    const args = { title: "Send the deck", due_iso: iso(day, false), notes: "the short one" };

    const question = await tool.confirmation(args);
    const result = await tool.run(args);

    expect(question).toBe(`Add this reminder?\nSend the deck\nDue ${LocalDateTime.spoken(day, false)}\nthe short one`);
    expect(store.addedReminders).toEqual([{ title: "Send the deck", list: "", due: day, dueHasTime: false, notes: "the short one" }]);
    expect(result).toBe(`Added "Send the deck" to the Reminders list, due ${describeDate(day, false)}.`);
    expect(await tool.confirmation({ title: "Call back" })).toBe("Add this reminder?\nCall back");
  });

  /** A time for `due_iso` is due then, and says so. */
  test("a reminder due at a time", async () => {
    const tool = new ReminderCreateTool(store);
    const args = { title: "Call back", due_iso: iso(at(9)) };

    expect(await tool.confirmation(args)).toBe(`Add this reminder?\nCall back\nDue ${LocalDateTime.spoken(at(9))}`);
    expect(await tool.run(args)).toBe(`Added "Call back" to the Reminders list, due ${describeDate(at(9))}.`);
    expect(store.addedReminders).toEqual([{ title: "Call back", list: "", due: at(9), dueHasTime: true, notes: null }]);
  });

  /** With no `due_iso`, it is due at no time, and says nothing of one. */
  test("a reminder due at no time", async () => {
    const tool = new ReminderCreateTool(store);

    expect(await tool.run({ title: "Call back" })).toBe(`Added "Call back" to the Reminders list.`);
    expect(store.addedReminders).toEqual([{ title: "Call back", list: "", due: null, dueHasTime: false, notes: null }]);
  });

  test.each<Record<string, unknown>>([{}, { title: "Call back", due_iso: "soon" }, { title: "Call back", due_iso: "0025-01-15" }])("%j is neither asked about nor added", async (args) => {
    const tool = new ReminderCreateTool(store);

    expect(await tool.confirmation(args)).toBeNull();
    await expect(tool.run(args)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(store.addedReminders).toEqual([]);
  });
});

describe("connectors", () => {
  /** Each app's switch covers its own tools, the reading one and the creating one, and only the
   * creating one asks first. */
  test("each app's switch covers its tools", async () => {
    const tools = [...calendarConnector.tools({ eventStore: store }), ...remindersConnector.tools({ eventStore: store })];
    expect(tools.map((tool) => [tool.connector, tool.name])).toEqual([
      ["calendar", "calendar_read"],
      ["calendar", "calendar_event_create"],
      ["reminders", "reminders_read"],
      ["reminders", "reminder_create"],
    ]);
    const valid = { title: "Example", start_iso: iso(at(10)) };
    expect(await Promise.all(tools.map(async (tool) => (await tool.confirmation(valid, new AbortController().signal)) !== null))).toEqual([false, true, false, true]);
  });
});

test("calendar writes disclose their fixed local provider destination", async () => {
  const provider = Object.assign(store, { calendarWriteDestination: "TabMail Voice calendar (local to this PC)" });
  const tool = new CalendarEventCreateTool(provider);
  const args = { title: "Synthetic", start_iso: iso(at(10)), calendar: "Cloud account" };
  provider.calendarWriteDestination = "Changed after tool construction";
  expect(await tool.confirmation(args)).toContain("Destination: TabMail Voice calendar (local to this PC)");
  expect(await tool.confirmation(args)).not.toContain("Cloud account");
  expect(await tool.run(args)).toContain("to TabMail Voice calendar (local to this PC):");
  expect(store.added[0]?.calendar).toBe("");
});

/** Apple Calendar's single-event access in memory: the events it knows by id (an occurrence by id and
 * its start), and what the tools asked of it. */
class FakeEditor implements EventEditor {
  byID = new Map<string, CalendarEvent>();
  calendarList: EventCalendar[] = [{ id: "calendar-work", title: "Work", account: "iCloud", isDefault: true }];
  readonly reads: [string, Date | null][] = [];
  readonly edits: { id: string; occurrence: Date | null; scope: EventScope; changes: EventChanges }[] = [];
  readonly deleted: string[] = [];
  /** What `edit` returns; the event as it was without it. */
  saved: CalendarEvent | null = null;
  /** What the next read throws, once: a helper that exited, a request that timed out. */
  failNext: Error | null = null;

  private failOnce(): void {
    const failure = this.failNext;
    this.failNext = null;
    if (failure) throw failure;
  }

  async event(id: string, occurrence: Date | null): Promise<CalendarEvent> {
    this.reads.push([id, occurrence]);
    this.failOnce();
    return this.find(id, occurrence);
  }

  private find(id: string, occurrence: Date | null): CalendarEvent {
    const found = this.byID.get(occurrence === null ? id : `${id}@${occurrence.getTime()}`) ?? this.byID.get(id);
    if (!found) throw new EventStoreError("noSuchEvent");
    return found;
  }

  async calendars(): Promise<EventCalendar[]> {
    this.failOnce();
    return this.calendarList;
  }

  async edit(id: string, occurrence: Date | null, scope: EventScope, changes: EventChanges): Promise<CalendarEvent> {
    this.edits.push({ id, occurrence, scope, changes });
    // The event saved, not a read: what the app reads is counted in `reads`.
    return this.saved ?? this.find(id, occurrence);
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
  }
}

function editableStore(editor: FakeEditor): FakeEventStore {
  return Object.assign(new FakeEventStore(), { editor });
}

/** The signal of a request still running. */
const live = new AbortController().signal;

/** Runs a write as the controller does: its question first, then the call the user confirmed. */
async function confirmed(tool: CalendarEventEditTool | CalendarEventDeleteTool, args: Record<string, unknown>, signal = live): Promise<string> {
  await tool.confirmation(args);
  return tool.run(args, signal);
}

const weekly: EventRecurrence = { frequency: "WEEKLY", interval: 1, count: null, until: null, days: [{ weekday: 2, week: 0 }], monthDays: [], months: [], positions: [], yearWeeks: [], yearDays: [] };

/** A weekly team meeting from 10:00 to 10:30, its occurrence on `day` named by its start. */
function standup(): CalendarEvent {
  return {
    ...event("Team sync", at(10), at(10, 30)),
    id: "series-1",
    occurrence: at(10),
    calendarId: "calendar-work",
    availability: "busy",
    attendees: [
      { email: "me@example.com", name: null, status: "accepted" },
      { email: "alex@example.com", name: "Alex Example", status: "pending" },
    ],
    organizer: { email: "me@example.com", name: null },
    recurrence: weekly,
    isDetached: false,
    isInvitation: false,
  };
}

describe("the connector with single-event access", () => {
  /** Reading one event, changing and deleting it come with the store that can; only the changes ask. */
  test("the calendar's tools include reading, changing and deleting one event", async () => {
    const tools = calendarConnector.tools({ eventStore: editableStore(new FakeEditor()) });
    expect(tools.map((tool) => tool.name)).toEqual(["calendar_read", "calendar_event_create", "calendar_event_read", "calendar_event_edit", "calendar_event_delete"]);
    expect(tools.every((tool) => tool.connector === "calendar")).toBe(true);
  });
});

describe("calendar_read with single-event access", () => {
  /** Each event carries what names it to the other tools, how it repeats, who is invited, and whether
   * it shows as free or was an invitation; the first page lists the calendars events can go in. */
  test("events carry their ids, repeating, attendees and the calendars", async () => {
    const editor = new FakeEditor();
    editor.calendarList = [...editor.calendarList, { id: "calendar-team", title: "Team", account: "Exchange", isDefault: false }];
    const store = editableStore(editor);
    const invitation = { ...event("Review", at(14), at(15)), id: "event-2", availability: "free" as const, organizer: { email: "pat@example.com", name: "Pat" }, attendees: [{ email: "pat@example.com", name: "Pat", status: "accepted" }], isInvitation: true };
    store.storedEvents = [standup(), invitation, { ...event("Lunch", at(12), at(13)), id: "event-3", recurrence: { ...weekly, interval: 2, days: [{ weekday: 2, week: 1 }, { weekday: 4, week: -1 }], count: 5 }, isDetached: true }];
    const result = await new CalendarReadTool(store, () => at(8)).run({});

    expect(result.split("\n")).toEqual([
      `Events from ${describeDate(day)} to ${describeDate(at(0, 0, 1))}:`,
      `- Team sync: ${describeDate(at(10))} to ${describeDate(at(10, 30))} (Work) [event_id series-1; recurrence_id ${iso(at(10))}; repeats FREQ=WEEKLY;BYDAY=MO; attendees me@example.com (accepted), Alex Example <alex@example.com> (pending)]`,
      `- Review: ${describeDate(at(14))} to ${describeDate(at(15))} (Work) [event_id event-2; shown as free; invited by Pat <pat@example.com>; attendees Pat <pat@example.com> (accepted)]`,
      `- Lunch: ${describeDate(at(12))} to ${describeDate(at(13))} (Work) [event_id event-3; repeats FREQ=WEEKLY;INTERVAL=2;BYDAY=1MO,-1WE;COUNT=5; this occurrence changed on its own]`,
      "Calendars events can be added to (for calendar_id):",
      "- Work (iCloud), the default: calendar-work",
      "- Team (Exchange): calendar-team",
    ]);
  });

  /** A range with more events than a page lists them a page at a time, saying which; a page past the
   * last is refused; the calendars come with the first page only. */
  test("a long range is read a page at a time", async () => {
    const store = editableStore(new FakeEditor());
    const size = config.calendarReadPageSize;
    store.storedEvents = Array.from({ length: size + 1 }, (_, index) => event(`Event ${index}`, at(9), at(10)));
    const tool = new CalendarReadTool(store, () => at(8));

    const first = (await tool.run({})).split("\n");
    const second = (await tool.run({ page_index: 2 })).split("\n");

    expect(first[0]).toBe(`Events from ${describeDate(day)} to ${describeDate(at(0, 0, 1))}, page 1 of 2:`);
    expect(first.filter((line) => line.startsWith("- Event"))).toHaveLength(size);
    expect(first).toContain("More events: call calendar_read again with page_index 2.");
    expect(first).toContain("Calendars events can be added to (for calendar_id):");
    expect(second).toEqual([`Events from ${describeDate(day)} to ${describeDate(at(0, 0, 1))}, page 2 of 2:`, `- Event ${size}: ${describeDate(at(9))} to ${describeDate(at(10))} (Work)`]);
    await expect(tool.run({ page_index: 3 })).rejects.toEqual(new ToolArgumentError("page_index is past the last page, 2."));
    for (const page of [0, 1.5, "2"]) await expect(tool.run({ page_index: page })).rejects.toBeInstanceOf(ToolArgumentError);
    store.storedEvents = [];
    await expect(tool.run({ page_index: 2 })).rejects.toEqual(new ToolArgumentError("page_index is past the last page, 1."));
  });
});

describe("calendar_event_create with single-event access", () => {
  /** An event in a chosen calendar, repeating, shown as free and inviting people: the user is asked
   * about every one of those, told the invitations are emailed, and it is added so. */
  test("an event is added to a calendar, repeating, inviting people", async () => {
    const editor = new FakeEditor();
    const store = editableStore(editor);
    const tool = new CalendarEventCreateTool(store);
    const args = {
      title: "Planning",
      start_iso: iso(at(10)),
      end_iso: iso(at(11)),
      calendar_id: "calendar-work",
      transparency: "free",
      recurrence: { freq: "weekly", byDay: ["MO", "WE"], until: iso(at(0, 0, 28), false) },
      attendees: [{ email: "alex@example.com", name: "Alex Example" }, { email: "ALEX@example.com" }, { email: "sam@example.com" }],
    };
    const until = new Date(at(0, 0, 29).getTime() - 1);

    expect((await tool.confirmation(args))?.split("\n")).toEqual([
      "Add this event to your calendar?",
      "Planning",
      "Calendar: Work (iCloud)",
      `${LocalDateTime.spoken(at(10))} to ${LocalDateTime.spoken(at(11))}`,
      `Repeats every week on Monday, Wednesday, until ${LocalDateTime.spoken(until, false)}`,
      "Shown as free",
      "Invite: Alex Example <alex@example.com>, sam@example.com",
      "They are emailed an invitation.",
    ]);
    const result = await tool.run(args);

    expect(store.added).toEqual([
      {
        ...event("Planning", at(10), at(11)),
        calendar: "",
        calendarId: "calendar-work",
        availability: "free",
        recurrence: { frequency: "WEEKLY", interval: 1, count: null, until, days: [{ weekday: 2, week: 0 }, { weekday: 4, week: 0 }], monthDays: [], months: [], positions: [], yearWeeks: [], yearDays: [] },
        attendees: [{ email: "alex@example.com", name: "Alex Example" }, { email: "sam@example.com", name: null }],
      },
    ]);
    expect(result).toBe(`Added "Planning" to the Work calendar: ${describeDate(at(10))} to ${describeDate(at(11))}.`);
  });

  /** An added event's id comes back; an invitee the calendar did not keep is reported, one it kept
   * (in any case) is not. */
  test("an added event's id comes back, and an invitation not kept is reported", async () => {
    const store = editableStore(new FakeEditor());
    store.addEvent = async (added) => ({ ...added, calendar: "Work", id: "event-9", attendees: [{ email: "sam@example.com", name: null, status: "pending" }] });
    const result = await new CalendarEventCreateTool(store).run({ title: "Planning", start_iso: iso(at(10)), attendees: [{ email: "Sam@example.com" }, { email: "alex@example.com" }] });
    expect(result).toBe(
      `Added "Planning" to the Work calendar: ${describeDate(at(10))} to ${describeDate(at(11))} (event_id event-9). The calendar did not keep the invitation for alex@example.com: they were not invited.`,
    );
  });

  /** A calendar that can't show free time keeps the event busy, and the model hears so. */
  test("an event the calendar keeps busy says so", async () => {
    const store = editableStore(new FakeEditor());
    store.addEvent = async (added) => ({ ...added, calendar: "Work", availability: "busy" });
    expect(await new CalendarEventCreateTool(store).run({ title: "Focus", start_iso: iso(at(10)), transparency: "free" })).toBe(
      `Added "Focus" to the Work calendar: ${describeDate(at(10))} to ${describeDate(at(11))}. The calendar can't show events as free, so it shows as busy.`,
    );
    const editor = new FakeEditor();
    editor.byID.set("event-1", { ...event("Focus", at(10), at(11)), id: "event-1", availability: "busy" });
    expect(await confirmed(new CalendarEventEditTool(editor), { event_id: "event-1", transparency: "free" })).toBe(
      `Changed "Focus": ${describeDate(at(10))} to ${describeDate(at(11))} (event_id event-1). The calendar can't show events as free, so it shows as busy.`,
    );
  });

  /** Without transparency, an event with people or a recurrence is added busy, as it was asked. */
  test("an event is added busy unless asked otherwise", async () => {
    const store = editableStore(new FakeEditor());
    const tool = new CalendarEventCreateTool(store);
    const args = { title: "Planning", start_iso: iso(at(10)), attendees: [{ email: "alex@example.com" }] };
    expect(await tool.confirmation(args)).not.toContain("free");
    await tool.run(args);
    expect(store.added.at(-1)?.availability).toBe("busy");
  });

  /** A calendar_id no calendar has is not asked about; adding goes to the store, which refuses it. */
  test("an unknown calendar is not asked about", async () => {
    const tool = new CalendarEventCreateTool(editableStore(new FakeEditor()));
    await expect(tool.confirmation({ title: "Planning", start_iso: iso(at(10)), calendar_id: "calendar-gone" })).rejects.toEqual(new EventStoreError("noSuchCalendar"));
  });

  /** Where the store can't do them, invitations, repeating, a chosen calendar and showing as free are
   * refused before anything is asked or added, and the model told what to leave out. */
  test.each<Record<string, unknown>>([
    { calendar_id: "calendar-work" },
    { transparency: "free" },
    { attendees: [{ email: "alex@example.com" }] },
    { recurrence: { freq: "DAILY" } },
  ])("without single-event access, %j is refused", async (extra) => {
    const tool = new CalendarEventCreateTool(store);
    const args = { title: "Planning", start_iso: iso(at(10)), ...extra };
    await expect(tool.confirmation(args)).rejects.toThrow();
    await expect(tool.run(args)).rejects.toThrow(/can't invite people, repeat events, choose a calendar or show an event as free/);
    expect(store.added).toEqual([]);
  });

  /** Busy, the default, is no capability the store lacks: without single-event access it is added. */
  test("without single-event access, busy is added", async () => {
    const tool = new CalendarEventCreateTool(store);
    const args = { title: "Planning", start_iso: iso(at(10)), transparency: "busy" };
    await expect(tool.confirmation(args)).resolves.toContain("Planning");
    await tool.run(args);
    expect(store.added).toHaveLength(1);
    expect(store.added[0]).toMatchObject({ title: "Planning", start: at(10) });
  });

  /** Recurrences Calendar can't keep, or that aren't recurrences, and people without an address are
   * refused before anything is asked or added. */
  test.each<[unknown, string]>([
    ["weekly", "recurrence is not an object."],
    [{ freq: "HOURLY" }, "recurrence.freq must be DAILY, WEEKLY, MONTHLY or YEARLY."],
    [{ freq: "DAILY", interval: 0 }, "recurrence.interval is not a whole number of 1 or more."],
    [{ freq: "DAILY", count: 2.5 }, "recurrence.count is not a whole number of 1 or more."],
    [{ freq: "DAILY", count: 1e100 }, "recurrence.count is not a whole number of 1 or more."],
    [{ freq: "DAILY", interval: 2 ** 53 }, "recurrence.interval is not a whole number of 1 or more."],
    [{ freq: "DAILY", count: 3, until: "2099-01-15" }, "recurrence takes count or until, not both."],
    [{ freq: "DAILY", until: "soon" }, "recurrence.until is not a date and time like 2025-01-15T14:00:00, or a day like 2025-01-15."],
    [{ freq: "DAILY", until: "2020-01-15" }, "recurrence.until is before the event starts."],
    [{ freq: "DAILY", byDay: ["MO"] }, "recurrence.byDay needs WEEKLY, MONTHLY or YEARLY."],
    [{ freq: "WEEKLY", byDay: ["2MO"] }, "A WEEKLY recurrence.byDay takes days alone, like MO, without a week number."],
    [{ freq: "WEEKLY", byDay: ["MONDAY"] }, 'recurrence.byDay has "MONDAY", which is not valid there.'],
    [{ freq: "MONTHLY", byDay: ["0MO"] }, 'recurrence.byDay has "0MO", which is not valid there.'],
    [{ freq: "MONTHLY", byDay: "MO" }, "recurrence.byDay is not a list."],
    [{ freq: "WEEKLY", byMonthDay: [15] }, "recurrence.byMonthDay needs MONTHLY."],
    [{ freq: "MONTHLY", byMonthDay: [32] }, "recurrence.byMonthDay has 32, which is not valid there."],
    [{ freq: "MONTHLY", byMonthDay: [0] }, "recurrence.byMonthDay has 0, which is not valid there."],
    [{ freq: "YEARLY", byDay: ["54MO"] }, 'recurrence.byDay has "54MO", which is not valid there.'],
    [{ freq: "MONTHLY", byMonth: [3] }, "recurrence.byMonth needs YEARLY."],
    [{ freq: "YEARLY", byMonth: [13] }, "recurrence.byMonth has 13, which is not valid there."],
    [{ freq: "YEARLY", byMonth: [0] }, "recurrence.byMonth has 0, which is not valid there."],
  ])("recurrence %j is refused", async (recurrence, message) => {
    const tool = new CalendarEventCreateTool(editableStore(new FakeEditor()));
    const args = { title: "Planning", start_iso: iso(at(10)), recurrence };
    await expect(tool.confirmation(args)).rejects.toThrow();
    await expect(tool.run(args)).rejects.toEqual(new ToolArgumentError(message));
  });

  test.each<unknown>([[{ name: "Alex" }], [{ email: "Alex Example" }], ["alex@example.com"], "alex@example.com"])("attendees %j are refused", async (attendees) => {
    const tool = new CalendarEventCreateTool(editableStore(new FakeEditor()));
    await expect(tool.run({ title: "Planning", start_iso: iso(at(10)), attendees })).rejects.toBeInstanceOf(ToolArgumentError);
  });

  /** A monthly recurrence by weekday and week, a yearly one by month and a monthly one by day are
   * kept as Calendar's rules say them; a timed until is exact. */
  test("monthly and yearly recurrences", async () => {
    const tool = new CalendarEventCreateTool(editableStore(new FakeEditor()));
    const draft = (recurrence: unknown) => tool.draft({ title: "Review", start_iso: iso(at(10)), recurrence }).recurrence;
    expect(draft({ freq: "MONTHLY", byDay: ["-1FR", "+2TU"], count: 6 })).toMatchObject({ frequency: "MONTHLY", days: [{ weekday: 6, week: -1 }, { weekday: 3, week: 2 }], count: 6 });
    expect(draft({ freq: "MONTHLY", byMonthDay: [1, -1], interval: 3 })).toMatchObject({ monthDays: [1, -1], interval: 3 });
    expect(draft({ freq: "YEARLY", byMonth: [1, 7], until: iso(at(18, 0, 400)) })).toMatchObject({ months: [1, 7], until: at(18, 0, 400) });
    expect(await tool.confirmation({ title: "Review", start_iso: iso(at(10)), recurrence: { freq: "MONTHLY", byDay: ["-1FR"], interval: 2, count: 6 } })).toContain(
      "Repeats every 2 months on the last Friday, 6 times",
    );
    expect(await tool.confirmation({ title: "Review", start_iso: iso(at(10)), recurrence: { freq: "YEARLY", byMonth: [3] } })).toContain("Repeats every year in March");
    expect(await tool.confirmation({ title: "Review", start_iso: iso(at(10)), recurrence: { freq: "MONTHLY", byMonthDay: [15] } })).toContain("Repeats every month on day 15");
    // A week with no word of its own is said by its number.
    expect(await tool.confirmation({ title: "Review", start_iso: iso(at(10)), recurrence: { freq: "YEARLY", byDay: ["20MO"] } })).toContain("Repeats every year on the week 20 Monday");
    // `{}` is no recurrence for a new event.
    expect(draft({})).toBeUndefined();
  });
});

describe("calendar_event_read", () => {
  /** By id (and an occurrence by its start), the event in full: when, where, how it repeats, who
   * organizes and attends it, its notes and its ids. */
  test("an event is read by its id", async () => {
    const editor = new FakeEditor();
    const meeting = { ...standup(), location: "Room 4", notes: "Agenda: https://example.com/agenda" };
    editor.byID.set("series-1", meeting);
    const tool = new CalendarEventReadTool(editableStore(editor), editor);

    const result = await tool.run({ event_id: "series-1", recurrence_id: iso(at(10)) });

    // Reading asks no question.
    expect(tool.confirmation()).toBeNull();
    expect(editor.reads).toEqual([["series-1", at(10)]]);
    expect(result.split("\n")).toEqual([
      "Team sync",
      `When: ${describeDate(at(10))} to ${describeDate(at(10, 30))}`,
      "Calendar: Work (calendar_id calendar-work)",
      "Location: Room 4",
      "Repeats: FREQ=WEEKLY;BYDAY=MO",
      "Shown as: busy",
      "Organizer: me@example.com",
      "Attendees: me@example.com (accepted), Alex Example <alex@example.com> (pending)",
      "Notes: Agenda: https://example.com/agenda",
      "event_id series-1",
      `recurrence_id ${iso(at(10))}`,
    ]);
    editor.byID.set("event-2", { ...event("Review", at(14), at(15)), id: "event-2", organizer: { email: "pat@example.com", name: "Pat" }, isInvitation: true, isDetached: true });
    expect(await tool.run({ event_id: "event-2" })).toContain("Organizer: Pat <pat@example.com> (the user was invited, so only the organizer can change it)");
    expect(await tool.run({ event_id: "event-2" })).toContain("This occurrence was changed on its own.");
    await expect(tool.run({ event_id: "gone" })).rejects.toEqual(new EventStoreError("noSuchEvent"));
    // An answer Calendar doesn't know is left unsaid.
    editor.byID.set("event-3", { ...event("Retro", at(14), at(15)), id: "event-3", attendees: [{ email: "sam@example.com", name: "Sam", status: "unknown" }] });
    expect((await tool.run({ event_id: "event-3" })).split("\n")).toContain("Attendees: Sam <sam@example.com>");
  });

  /** Without an id, by when it starts (and its title, any case): every event starting then. */
  test("an event is found by when it starts", async () => {
    const editor = new FakeEditor();
    const store = editableStore(editor);
    store.storedEvents = [{ ...event("Launch review", at(10), at(11)), id: "event-1" }, { ...event("Lunch", at(10), at(11)), id: "event-2" }, { ...event("Earlier", at(9), at(11)), id: "event-3" }, { ...event("Later", new Date(at(10).getTime() + config.calendarEventStartTolerance), at(11)), id: "event-4" }];
    const tool = new CalendarEventReadTool(store, editor);

    expect(await tool.run({ start_iso: iso(at(10)), title: "launch REVIEW" })).toContain("event_id event-1");
    const both = await tool.run({ start_iso: iso(at(10)) });
    expect(both).toContain("event_id event-1");
    expect(both).toContain("event_id event-2");
    expect(both).not.toContain("event-3");
    expect(both).not.toContain("event-4");
    expect(store.readRanges[0]).toEqual([at(10), new Date(at(10).getTime() + config.calendarEventStartTolerance)]);
    expect(await tool.run({ start_iso: iso(at(10)), title: "Dinner" })).toBe(`No event starts at ${describeDate(at(10))} titled "Dinner".`);
    expect(await tool.run({ start_iso: iso(day, false) })).toBe(`No event starts at ${describeDate(day, false)}.`);
    await expect(tool.run({})).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(tool.run({ start_iso: "soon" })).rejects.toBeInstanceOf(ToolArgumentError);
  });
});

describe("calendar_event_edit", () => {
  let editor: FakeEditor;
  let tool: CalendarEventEditTool;
  beforeEach(() => {
    editor = new FakeEditor();
    editor.byID.set("event-1", { ...event("Launch review", at(10), at(10, 30), { location: "Room 4" }), id: "event-1", attendees: [], organizer: null, recurrence: null });
    editor.byID.set("series-1", standup());
    tool = new CalendarEventEditTool(editor);
  });

  const lastChanges = () => editor.edits.at(-1)?.changes;

  /** A new start alone keeps the event's length; a new end alone keeps it too, moving the start; both
   * set both. The user is asked about the event as it is and the change. */
  test("a moved event keeps its length", async () => {
    const args = { event_id: "event-1", start_iso: iso(at(15)) };
    expect((await tool.confirmation(args))?.split("\n")).toEqual([
      "Change this event?",
      "Launch review",
      `${LocalDateTime.spoken(at(10))} to ${LocalDateTime.spoken(at(10, 30))}`,
      `New time: ${LocalDateTime.spoken(at(15))} to ${LocalDateTime.spoken(at(15, 30))}`,
    ]);
    expect(await tool.run(args, live)).toBe(`Changed "Launch review": ${describeDate(at(10))} to ${describeDate(at(10, 30))} (event_id event-1).`);
    expect(editor.edits).toEqual([{ id: "event-1", occurrence: null, scope: "all", changes: { start: at(15), end: at(15, 30), isAllDay: false, invite: [], uninvite: [], exclude: [] } }]);

    await confirmed(tool, { event_id: "event-1", end_iso: iso(at(12)) }, live);
    expect(lastChanges()).toMatchObject({ start: at(11, 30), end: at(12) });
    await confirmed(tool, { event_id: "event-1", start_iso: iso(at(9)), end_iso: iso(at(11)) }, live);
    expect(lastChanges()).toMatchObject({ start: at(9), end: at(11) });
    await expect(confirmed(tool, { event_id: "event-1", start_iso: iso(at(9)), end_iso: iso(at(8)) }, live)).rejects.toEqual(new ToolArgumentError("end_iso is before start_iso."));
  });

  /** A day makes a timed event all day (one day, unless an end is given); a time makes an all-day
   * event timed, lasting the default; an all-day event moved keeps its days. */
  test("between all day and timed", async () => {
    await confirmed(tool, { event_id: "event-1", start_iso: iso(at(0, 0, 1), false) }, live);
    expect(lastChanges()).toMatchObject({ start: at(0, 0, 1), end: at(0, 0, 1), isAllDay: true });
    await confirmed(tool, { event_id: "event-1", all_day: true }, live);
    expect(lastChanges()).toMatchObject({ start: day, end: day, isAllDay: true });
    // A timed event past midnight made all day lasts its first day.
    editor.byID.set("late", { ...event("Late shift", at(22), at(1, 0, 1)), id: "late" });
    await confirmed(tool, { event_id: "late", all_day: true }, live);
    expect(lastChanges()).toMatchObject({ start: day, end: day, isAllDay: true });

    editor.byID.set("trip", { ...event("Trip", day, new Date(at(0, 0, 3).getTime() - 1000), { allDay: true }), id: "trip" });
    await confirmed(tool, { event_id: "trip", start_iso: iso(at(0, 0, 7), false) }, live);
    expect(lastChanges()).toMatchObject({ start: at(0, 0, 7), end: at(0, 0, 9), isAllDay: true });
    await confirmed(tool, { event_id: "trip", end_iso: iso(at(0, 0, 5), false) }, live);
    expect(lastChanges()).toMatchObject({ start: at(0, 0, 3), end: at(0, 0, 5), isAllDay: true });
    await confirmed(tool, { event_id: "trip", start_iso: iso(at(0, 0, 10), false), end_iso: iso(at(0, 0, 13), false) }, live);
    expect(lastChanges()).toMatchObject({ start: at(0, 0, 10), end: at(0, 0, 13), isAllDay: true });
    await confirmed(tool, { event_id: "trip", all_day: true }, live);
    expect(lastChanges()).toMatchObject({ start: day, end: at(0, 0, 2), isAllDay: true });
    await confirmed(tool, { event_id: "trip", start_iso: iso(at(9)) }, live);
    expect(lastChanges()).toMatchObject({ start: at(9), end: new Date(at(9).getTime() + config.calendarEventDefaultDuration), isAllDay: false });
    await confirmed(tool, { event_id: "trip", all_day: false }, live);
    expect(lastChanges()).toMatchObject({ start: day, end: new Date(day.getTime() + config.calendarEventDefaultDuration), isAllDay: false });
    await confirmed(tool, { event_id: "trip", end_iso: iso(at(18)) }, live);
    expect(lastChanges()).toMatchObject({ start: new Date(at(18).getTime() - config.calendarEventDefaultDuration), end: at(18), isAllDay: false });
  });

  /** Title, place, notes and free or busy change as given; "" removes a place or notes; every one is
   * shown to the user. */
  test("the event's fields change as given", async () => {
    const args = { event_id: "event-1", title: "Kickoff", location: "", notes: "Bring https://example.com/deck", transparency: "free" };
    expect((await tool.confirmation(args))?.split("\n").slice(3)).toEqual(["New title: Kickoff", "Remove the location", "New notes: Bring https://example.com/deck", "Shown as free"]);
    await confirmed(tool, args, live);
    expect(lastChanges()).toEqual({ title: "Kickoff", location: "", notes: "Bring https://example.com/deck", availability: "free", invite: [], uninvite: [], exclude: [] });
    expect((await tool.confirmation({ event_id: "event-1", location: "Room 5", notes: " " }))?.split("\n").slice(3)).toEqual(["New location: Room 5", "Remove the notes"]);
  });

  /** People are invited and removed by email, the user told they are emailed; one not on the event
   * is ignored, and "*" names no one. */
  test("people are invited and removed", async () => {
    const args = { event_id: "series-1", add_attendees: [{ email: "sam@example.com", name: "Sam" }], remove_attendees: [{ email: "ALEX@example.com" }, { email: "nobody@example.com" }] };
    const question = (await tool.confirmation(args))?.split("\n");
    expect(question?.slice(3)).toEqual(["Every occurrence", "Invite: Sam <sam@example.com>", "They are emailed an invitation.", "Remove: alex@example.com", "They are emailed that they are no longer invited.", "Its attendees are emailed the change."]);
    await confirmed(tool, args, live);
    expect(editor.edits.at(-1)).toMatchObject({ id: "series-1", occurrence: null, scope: "all", changes: { invite: [{ email: "sam@example.com", name: "Sam" }], uninvite: ["alex@example.com"] } });
    await expect(confirmed(tool, { event_id: "series-1", remove_attendees: [{ email: "*" }] }, live)).rejects.toEqual(new ToolArgumentError("Nothing to change: give the fields to change."));
    await expect(confirmed(tool, { event_id: "series-1", remove_attendees: [{ name: "Alex" }] }, live)).rejects.toEqual(new ToolArgumentError("remove_attendees has an item without an email."));
    await expect(confirmed(tool, { event_id: "series-1", remove_attendees: "alex@example.com" }, live)).rejects.toBeInstanceOf(ToolArgumentError);
  });

  /** An event whose one attendee is its organizer, the user (as Calendar keeps an event once everyone
   * else is removed), emails no one, and its question says nobody is. */
  test("an event with only its organizer emails no one", async () => {
    editor.byID.set("event-1", { ...standup(), id: "event-1", recurrence: null, attendees: [{ email: "Me@Example.com", name: null, status: "accepted" }] });
    const question = await tool.confirmation({ event_id: "event-1", title: "Kickoff" });
    expect(question.split("\n").slice(3)).toEqual(["New title: Kickoff"]);
    expect(question).not.toContain("emailed");
  });

  /** Only the people the user was shown are removed: someone invited in Calendar while the question
   * is open stays invited. */
  test("someone added while asked is not removed", async () => {
    const args = { event_id: "series-1", remove_attendees: [{ email: "alex@example.com" }] };
    expect(await tool.confirmation(args)).toContain("Remove: alex@example.com");
    const sam = { email: "sam@example.com", name: "Sam", status: "pending" };
    editor.byID.set("series-1", { ...standup(), attendees: [...(standup().attendees ?? []), sam] });
    await tool.run(args, live);
    expect(lastChanges()?.uninvite).toEqual(["alex@example.com"]);
  });

  /** The change made is the one confirmed: an event changed in Calendar while the question is open
   * gets the times the user was shown, and loses only the people the question named. */
  test("an event changed while asked gets the change confirmed", async () => {
    const args = { event_id: "event-1", start_iso: iso(at(14)), remove_attendees: [{ email: "sam@example.com" }] };
    expect(await tool.confirmation(args)).toContain(`New time: ${LocalDateTime.spoken(at(14))} to ${LocalDateTime.spoken(at(14, 30))}`);
    const sam = { email: "sam@example.com", name: "Sam", status: "pending" };
    editor.byID.set("event-1", { ...editor.byID.get("event-1")!, end: at(13), attendees: [sam] });
    await tool.run(args, live);
    expect(lastChanges()).toMatchObject({ start: at(14), end: at(14, 30), uninvite: [] });
  });

  /** The organizer, the user, is never removed from their own event, even when named. */
  test("the organizer is not removed", async () => {
    const args = { event_id: "series-1", remove_attendees: [{ email: "Me@example.com" }, { email: "alex@example.com" }] };
    const question = await tool.confirmation(args);
    expect(question).toContain("Remove: alex@example.com");
    expect(question).not.toContain("me@example.com");
    await tool.run(args, live);
    expect(lastChanges()?.uninvite).toEqual(["alex@example.com"]);
    await expect(tool.confirmation({ event_id: "series-1", remove_attendees: [{ email: "me@example.com" }] })).rejects.toThrow("Nothing to change");
  });

  /** The model hears of an invitee the calendar did not keep. */
  test("an invitation the calendar did not keep is reported", async () => {
    editor.saved = standup();
    const result = await confirmed(tool, { event_id: "series-1", add_attendees: [{ email: "sam@example.com" }, { email: "alex@example.com" }] }, live);
    expect(result).toBe(`Changed "Team sync": ${describeDate(at(10))} to ${describeDate(at(10, 30))} (event_id series-1, recurrence_id ${iso(at(10))}). The calendar did not keep the invitation for sam@example.com: they were not invited.`);
  });

  /** A repeating event changes over the occurrences `edit_scope` names: a recurrence_id alone means
   * that occurrence; with none, the series. New times need the occurrence they are for. */
  test("a repeating event changes over the occurrences asked", async () => {
    const occurrence = iso(at(10));
    await confirmed(tool, { event_id: "series-1", recurrence_id: occurrence, title: "Sync" }, live);
    expect(editor.edits.at(-1)).toMatchObject({ occurrence: at(10), scope: "thisOnly" });
    expect((await tool.confirmation({ event_id: "series-1", recurrence_id: occurrence, title: "Sync" }))?.split("\n")[3]).toBe(`Only the occurrence on ${LocalDateTime.spoken(at(10), false)}`);

    await confirmed(tool, { event_id: "series-1", recurrence_id: occurrence, edit_scope: "this_and_following", start_iso: iso(at(11)) }, live);
    expect(editor.edits.at(-1)).toMatchObject({ occurrence: at(10), scope: "thisAndFollowing", changes: { start: at(11), end: at(11, 30) } });
    expect((await tool.confirmation({ event_id: "series-1", recurrence_id: occurrence, edit_scope: "this_and_following", start_iso: iso(at(11)) }))?.split("\n").slice(3, 6)).toEqual([
      `The occurrence on ${LocalDateTime.spoken(at(10), false)} and every one after it`,
      `New time: ${LocalDateTime.spoken(at(11))} to ${LocalDateTime.spoken(at(11, 30))}`,
      "Every occurrence covered moves by as much, and any deleted from the series come back.",
    ]);

    await confirmed(tool, { event_id: "series-1", recurrence_id: occurrence, edit_scope: "all", start_iso: iso(at(9)) }, live);
    expect(editor.edits.at(-1)).toMatchObject({ occurrence: at(10), scope: "all", changes: { start: at(9), end: at(9, 30) } });

    await expect(confirmed(tool, { event_id: "series-1", start_iso: iso(at(9)) }, live)).rejects.toEqual(
      new ToolArgumentError("A repeating event's new start_iso or end_iso needs recurrence_id: the occurrence those times are for."),
    );
    await expect(confirmed(tool, { event_id: "series-1", edit_scope: "this_only", title: "Sync" }, live)).rejects.toEqual(new ToolArgumentError("edit_scope this_only needs recurrence_id: the occurrence it starts from."));
    await expect(confirmed(tool, { event_id: "series-1", edit_scope: "some", title: "Sync" }, live)).rejects.toEqual(new ToolArgumentError("edit_scope must be all, this_only or this_and_following."));
    // A single event's scope is itself.
    await confirmed(tool, { event_id: "event-1", recurrence_id: iso(at(10)), edit_scope: "this_and_following", title: "Kickoff" }, live);
    expect(editor.edits.at(-1)).toMatchObject({ id: "event-1", scope: "all" });
  });

  /** How an event repeats is set, changed or ended ({}) for the series or from an occurrence on, never
   * for one occurrence; occurrences are dropped by their starts. */
  test("repeating is set, ended, and occurrences dropped", async () => {
    await confirmed(tool, { event_id: "event-1", recurrence: { freq: "DAILY", count: 3 } }, live);
    expect(lastChanges()?.recurrence).toEqual({ frequency: "DAILY", interval: 1, count: 3, until: null, days: [], monthDays: [], months: [], positions: [], yearWeeks: [], yearDays: [] });
    expect(await tool.confirmation({ event_id: "event-1", recurrence: { freq: "DAILY", count: 3 } })).toContain("Repeats every day, 3 times");
    await confirmed(tool, { event_id: "series-1", recurrence: {} }, live);
    expect(lastChanges()?.recurrence).toBeNull();
    expect(await tool.confirmation({ event_id: "series-1", recurrence: {} })).toContain("Stops repeating");
    await expect(confirmed(tool, { event_id: "series-1", recurrence_id: iso(at(10)), recurrence: { freq: "DAILY" } }, live)).rejects.toBeInstanceOf(ToolArgumentError);
    // A new last day is checked against the start the rule is written from: from an occurrence on, its
    // new start, so one before it would end those occurrences before they begin.
    const following = { event_id: "series-1", recurrence_id: iso(at(10)), edit_scope: "this_and_following", start_iso: iso(at(10, 0, 14)) };
    await expect(confirmed(tool, { ...following, recurrence: { freq: "WEEKLY", until: iso(at(0, 0, 7), false) } }, live)).rejects.toEqual(new ToolArgumentError("recurrence.until is before the event starts."));
    await confirmed(tool, { ...following, recurrence: { freq: "WEEKLY", until: iso(at(0, 0, 21), false) } }, live);
    expect(lastChanges()).toMatchObject({ start: at(10, 0, 14), recurrence: { frequency: "WEEKLY" } });
    // The whole series named from a later occurrence starts before it: a last day between the two shortens it.
    editor.byID.set(`series-1@${at(10, 0, 14).getTime()}`, { ...standup(), start: at(10, 0, 14), end: at(10, 30, 14), occurrence: at(10, 0, 14) });
    await confirmed(tool, { event_id: "series-1", recurrence_id: iso(at(10, 0, 14)), edit_scope: "all", recurrence: { freq: "WEEKLY", until: iso(at(0, 0, 10), false) } }, live);
    expect(editor.edits.at(-1)).toMatchObject({ occurrence: at(10, 0, 14), scope: "all", changes: { recurrence: { until: new Date(at(0, 0, 11).getTime() - 1) } } });

    const dropped = [iso(at(10, 0, 7)), iso(at(10, 0, 14))];
    await confirmed(tool, { event_id: "series-1", exdates_add: dropped }, live);
    expect(lastChanges()?.exclude).toEqual([at(10, 0, 7), at(10, 0, 14)]);
    expect(await tool.confirmation({ event_id: "series-1", exdates_add: dropped })).toContain(`Delete the occurrences on: ${LocalDateTime.spoken(at(10, 0, 7))}; ${LocalDateTime.spoken(at(10, 0, 14))}`);
    await expect(confirmed(tool, { event_id: "event-1", exdates_add: dropped }, live)).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(confirmed(tool, { event_id: "series-1", recurrence_id: iso(at(10)), exdates_add: [iso(at(10))] }, live)).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(confirmed(tool, { event_id: "series-1", exdates_add: ["soon"] }, live)).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(confirmed(tool, { event_id: "series-1", exdates_add: iso(at(10)) }, live)).rejects.toBeInstanceOf(ToolArgumentError);
  });

  /** An occurrence changed on its own (which Calendar gives its series' rule) changes alone through
   * its own id, with a recurrence_id or without: not the series, nor how it repeats. */
  test("an occurrence changed on its own changes alone", async () => {
    editor.byID.set("series-1/moved", { ...standup(), id: "series-1/moved", isDetached: true });
    expect((await tool.confirmation({ event_id: "series-1/moved", title: "Sync" })).split("\n").slice(3)).toEqual(["Only this occurrence: it was changed on its own", "New title: Sync", "Its attendees are emailed the change."]);
    await confirmed(tool, { event_id: "series-1/moved", title: "Sync" }, live);
    expect(editor.edits.at(-1)).toMatchObject({ id: "series-1/moved", occurrence: null, scope: "thisOnly", changes: { title: "Sync" } });
    const moved = { event_id: "series-1/moved", start_iso: iso(at(15, 0, 1)) };
    expect(await tool.confirmation(moved)).not.toMatch(/Every occurrence/);
    await confirmed(tool, moved, live);
    expect(editor.edits.at(-1)).toMatchObject({ scope: "thisOnly", changes: { start: at(15, 0, 1), end: at(15, 30, 1) } });
    await confirmed(tool, { event_id: "series-1/moved", recurrence_id: iso(at(10)), edit_scope: "this_only", title: "Sync" }, live);
    expect(editor.edits.at(-1)).toMatchObject({ scope: "thisOnly" });
    for (const extra of [{ edit_scope: "all" }, { edit_scope: "this_and_following" }, { recurrence: { freq: "DAILY" } }]) {
      await expect(confirmed(tool, { event_id: "series-1/moved", title: "Sync", ...extra }, live)).rejects.toThrow(/changed on its own, so its event_id changes it alone/);
    }
    await expect(confirmed(tool, { event_id: "series-1/moved", exdates_add: [iso(at(10, 0, 7))] }, live)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(editor.edits).toHaveLength(3);
  });

  /** A series whose rule names its days (Mondays, the first Monday) moves to another day only with
   * the days it moves to, which the user then confirms; at another time of the same day, or with a
   * rule that repeats its start's day, it moves as asked. */
  test("a series moved to another day needs the days it moves to", async () => {
    const occurrence = iso(at(10));
    const refused = new ToolArgumentError("This series repeats FREQ=WEEKLY;BYDAY=MO: to move it to another day, give recurrence with the days it moves to.");
    for (const scope of ["all", "this_and_following"]) {
      const args = { event_id: "series-1", recurrence_id: occurrence, edit_scope: scope, start_iso: iso(at(10, 0, 1)) };
      await expect(tool.confirmation(args)).rejects.toEqual(refused);
      await expect(confirmed(tool, args, live)).rejects.toEqual(refused);
    }
    expect(editor.edits).toEqual([]);

    const withDays = { event_id: "series-1", recurrence_id: occurrence, start_iso: iso(at(10, 0, 1)), edit_scope: "all", recurrence: { freq: "WEEKLY", byDay: ["TU"] } };
    expect(await tool.confirmation(withDays)).toContain("Repeats every week on Tuesday");
    await confirmed(tool, withDays, live);
    expect(lastChanges()).toMatchObject({ start: at(10, 0, 1), recurrence: { days: [{ weekday: 3, week: 0 }] } });
    await confirmed(tool, { event_id: "series-1", recurrence_id: occurrence, edit_scope: "all", start_iso: iso(at(16)) }, live);
    expect(lastChanges()).toMatchObject({ start: at(16) });
    await confirmed(tool, { event_id: "series-1", recurrence_id: occurrence, edit_scope: "this_only", start_iso: iso(at(10, 0, 1)) }, live);
    expect(lastChanges()).toMatchObject({ start: at(10, 0, 1) });
    for (const rule of [{ monthDays: [15] }, { positions: [-1] }, { months: [3] }, { yearWeeks: [20] }, { yearDays: [100] }]) {
      editor.byID.set("series-2", { ...standup(), id: "series-2", recurrence: { ...weekly, days: [], ...rule } });
      await expect(confirmed(tool, { event_id: "series-2", recurrence_id: occurrence, start_iso: iso(at(10, 0, 1)), edit_scope: "all" }, live)).rejects.toBeInstanceOf(ToolArgumentError);
    }
    editor.byID.set("series-2", { ...standup(), id: "series-2", recurrence: { ...weekly, days: [] } });
    await confirmed(tool, { event_id: "series-2", recurrence_id: occurrence, start_iso: iso(at(10, 0, 1)), edit_scope: "all" }, live);
    expect(editor.edits.at(-1)).toMatchObject({ id: "series-2", changes: { start: at(10, 0, 1) } });
    expect(editor.edits).toHaveLength(4);
  });

  /** The day a move lands on is counted in the event's own zone, where Calendar counts its rule's
   * days: a move within the Mac's day can cross a day there. */
  test("a series' day is counted in its own zone", async () => {
    // A zone 12 hours off the Mac's (within the zones there are): 11:00 and 13:00 here are on two days there.
    const hours = -at(11).getTimezoneOffset() / 60;
    const offset = hours + 12 <= 14 ? hours + 12 : hours - 12;
    const zone = `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(Math.trunc(offset))}`;
    editor.byID.set("series-1", { ...standup(), start: at(11), end: at(11, 30), occurrence: at(11), timeZone: zone });
    const args = { event_id: "series-1", recurrence_id: iso(at(11)), edit_scope: "all", start_iso: iso(at(13)) };
    await expect(tool.confirmation(args)).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(confirmed(tool, args, live)).rejects.toBeInstanceOf(ToolArgumentError);
    // The same zone as macOS names a zone that is only an offset.
    const fixed = `GMT${offset > 0 ? "+" : "-"}${String(Math.abs(Math.trunc(offset))).padStart(2, "0")}00`;
    editor.byID.set("series-1", { ...standup(), start: at(11), end: at(11, 30), occurrence: at(11), timeZone: fixed });
    await expect(tool.confirmation(args)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(editor.edits).toEqual([]);

    editor.byID.set("series-1", { ...standup(), start: at(11), end: at(11, 30), occurrence: at(11), timeZone: null });
    await confirmed(tool, args, live);
    expect(lastChanges()).toMatchObject({ start: at(13) });
  });

  /** Occurrences are not deleted in the edit that moves their series, which would bring them back; one
   * occurrence moved can go with others deleted. */
  test("deleting occurrences doesn't go with moving the series", async () => {
    const occurrence = iso(at(10));
    for (const edit_scope of ["all", "this_and_following"]) {
      const args = { event_id: "series-1", recurrence_id: occurrence, edit_scope, start_iso: iso(at(11)), exdates_add: [iso(at(10, 0, 14))] };
      await expect(tool.confirmation(args)).rejects.toEqual(
        new ToolArgumentError("exdates_add can't go with new times for the series, which bring deleted occurrences back: move it first, then read it and delete the occurrences at their new times."),
      );
      await expect(confirmed(tool, args, live)).rejects.toBeInstanceOf(ToolArgumentError);
    }
    expect(editor.edits).toEqual([]);
    await confirmed(tool, { event_id: "series-1", recurrence_id: occurrence, start_iso: iso(at(11)), exdates_add: [iso(at(10, 0, 14))] }, live);
    expect(editor.edits.at(-1)).toMatchObject({ scope: "thisOnly", changes: { start: at(11), exclude: [at(10, 0, 14)] } });
    await confirmed(tool, { event_id: "series-1", recurrence_id: occurrence, edit_scope: "all", title: "Sync", exdates_add: [iso(at(10, 0, 14))] }, live);
    expect(editor.edits.at(-1)).toMatchObject({ scope: "all", changes: { title: "Sync", exclude: [at(10, 0, 14)] } });
  });

  /** A call that changes nothing, names no event, or names one there isn't is not asked about and
   * changes nothing. */
  test.each<Record<string, unknown>>([{ event_id: "event-1" }, { title: "Kickoff" }, { event_id: "gone", title: "Kickoff" }, { event_id: "event-1", transparency: "maybe" }, { event_id: "event-1", exdates_add: [] }])(
    "%j is neither asked about nor changed",
    async (args) => {
      await expect(tool.confirmation(args)).rejects.toThrow();
      await expect(confirmed(tool, args, live)).rejects.toBeInstanceOf(Error);
      expect(editor.edits).toEqual([]);
    },
  );
});

describe("calendar_event_delete", () => {
  /** The user is asked about the event as it is: every occurrence of a repeating one, its attendees
   * told; an invitation is only removed from their calendar. */
  test("an event is deleted once the user confirms", async () => {
    const editor = new FakeEditor();
    editor.byID.set("series-1", standup());
    editor.byID.set("event-2", { ...event("Review", at(14), at(15)), organizer: { email: "pat@example.com", name: "Pat" }, attendees: [{ email: "pat@example.com", name: "Pat" }], isInvitation: true });
    editor.byID.set("event-3", { ...event("Focus", at(16), at(17)), attendees: [] });
    const tool = new CalendarEventDeleteTool(editor);

    expect((await tool.confirmation({ event_id: "series-1" }))?.split("\n")).toEqual([
      "Delete this event?",
      "Team sync",
      `${LocalDateTime.spoken(at(10))} to ${LocalDateTime.spoken(at(10, 30))}`,
      "Every occurrence is deleted.",
      "Its attendees are emailed a cancellation.",
    ]);
    expect(await tool.confirmation({ event_id: "event-2" })).toContain("You were invited to it: it is removed from your calendar.");
    // As the helper sends one: its own id, and its series' rule.
    editor.byID.set("series-1/moved", { ...standup(), id: "series-1/moved", isDetached: true });
    expect((await tool.confirmation({ event_id: "series-1/moved" })).split("\n").slice(3)).toEqual(["Only this occurrence is deleted: it was changed on its own.", "Its attendees are emailed a cancellation."]);
    expect(await tool.confirmation({ event_id: "event-3" })).toBe(`Delete this event?\nFocus\n${LocalDateTime.spoken(at(16))} to ${LocalDateTime.spoken(at(17))}`);
    // Its one attendee its organizer, the user: no one is emailed a cancellation.
    editor.byID.set("solo", { ...standup(), id: "solo", recurrence: null, attendees: [{ email: "Me@Example.com", name: null, status: "accepted" }] });
    expect((await tool.confirmation({ event_id: "solo" })).split("\n").slice(3)).toEqual([]);
    expect(await confirmed(tool, { event_id: "series-1" }, live)).toBe('Deleted "Team sync", every occurrence.');
    expect(await confirmed(tool, { event_id: "event-2" }, live)).toBe('Deleted "Review".');
    expect(await confirmed(tool, { event_id: "series-1/moved" }, live)).toBe('Deleted "Team sync".');
    expect(editor.deleted).toEqual(["series-1", "event-2", "series-1/moved"]);

    await expect(tool.confirmation({})).rejects.toThrow();
    await expect(tool.confirmation({ event_id: "gone" })).rejects.toThrow();
    await expect(confirmed(tool, { event_id: "gone" }, live)).rejects.toEqual(new EventStoreError("noSuchEvent"));
    expect(editor.deleted).toEqual(["series-1", "event-2", "series-1/moved"]);
  });

  test("the refusals single-event access adds say what the model can do", () => {
    expect(new EventStoreError("noSuchEvent").message).toContain("Read the calendar again");
    expect(new EventStoreError("noSuchCalendar").message).toContain("calendar_read lists the calendars");
    expect(new EventStoreError("calendarNoInvitations").message).toContain("iCloud, Google or Exchange");
    expect(new EventStoreError("notOrganizer").message).toContain("only the organizer can change it");
  });
});

/** Nothing is written that the user wasn't asked about: a read failing while the question is made
 * (the helper exited, a request timed out) fails the call, which the controller reports without
 * running the tool, though the same read would succeed when run. */
describe("a write is never made unasked", () => {
  const cases: [string, (editor: FakeEditor, store: FakeEventStore) => { tool: CalendarEventCreateTool | CalendarEventEditTool | CalendarEventDeleteTool; args: Record<string, unknown>; written: () => unknown[] }][] = [
    ["create", (_editor, store) => ({ tool: new CalendarEventCreateTool(store), args: { title: "Planning", start_iso: iso(at(10)), calendar_id: "calendar-work" }, written: () => store.added })],
    ["edit", (editor) => ({ tool: new CalendarEventEditTool(editor), args: { event_id: "series-1", title: "Sync" }, written: () => editor.edits })],
    ["delete", (editor) => ({ tool: new CalendarEventDeleteTool(editor), args: { event_id: "series-1" }, written: () => editor.deleted })],
  ];

  test.each(cases)("a failed read fails %s's question, and the next one asks", async (_name, make) => {
    const editor = new FakeEditor();
    editor.byID.set("series-1", standup());
    const store = editableStore(editor);
    const { tool, args, written } = make(editor, store);
    editor.failNext = new Error("voice-macos exited");

    await expect(tool.confirmation(args)).rejects.toThrow("voice-macos exited");
    expect(written()).toEqual([]);
    expect(await tool.confirmation(args)).toEqual(expect.any(String));
  });

  /** A write runs once for each question the user confirmed, and is never planned again: unasked or
   * canceled it changes nothing, and the event isn't read when it runs. */
  test.each(cases.slice(1))("%s runs only what the user confirmed", async (_name, make) => {
    const editor = new FakeEditor();
    editor.byID.set("series-1", standup());
    const { tool, args, written } = make(editor, editableStore(editor));
    const request = new AbortController();

    await expect(tool.run(args, live)).rejects.toThrow("needs a new confirmation");
    expect(editor.reads).toEqual([]);
    await tool.confirmation(args);
    request.abort();
    await expect(tool.run(args, request.signal)).rejects.toBeInstanceOf(CancellationError);
    await expect(tool.run(args, live)).rejects.toThrow("needs a new confirmation");
    expect(written()).toEqual([]);

    await tool.confirmation(args);
    const reads = editor.reads.length;
    await tool.run(args, live);
    expect(written()).toHaveLength(1);
    expect(editor.reads).toHaveLength(reads);
    await expect(tool.run(args, live)).rejects.toThrow("needs a new confirmation");
    expect(written()).toHaveLength(1);
  });
});

/** A rule read from Calendar is given to the model in full: its end, and the occurrences it selects
 * in each period ("the last weekday"), never a broader rule. */
test("a rule read from Calendar is described in full", async () => {
  const editor = new FakeEditor();
  const store = editableStore(editor);
  const until = new Date(at(23, 30, 60).getTime() + 45 * 1_000);
  const lastWeekday: EventRecurrence = { ...weekly, frequency: "MONTHLY", days: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, week: 0 })), positions: [-1], until };
  store.storedEvents = [
    { ...standup(), recurrence: lastWeekday },
    { ...standup(), id: "series-2", recurrence: { ...weekly, frequency: "YEARLY", days: [], yearWeeks: [20], yearDays: [100] } },
    { ...standup(), id: "series-3", recurrence: { ...weekly, frequency: "YEARLY", days: [], monthDays: [15, -1], months: [3, 9] } },
  ];

  const lines = (await new CalendarReadTool(store, () => at(8)).run({})).split("\n");

  expect(lines[1]).toContain(`repeats FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;UNTIL=${LocalDateTime.iso(until)}`);
  expect(lines[2]).toContain("repeats FREQ=YEARLY;BYWEEKNO=20;BYYEARDAY=100");
  expect(lines[3]).toContain("repeats FREQ=YEARLY;BYMONTHDAY=15,-1;BYMONTH=3,9");
});
