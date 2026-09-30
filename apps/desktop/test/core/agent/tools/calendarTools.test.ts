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
  CalendarReadTool,
  calendarTools,
  type EventStore,
  EventStoreFailure,
  type ReminderItem,
  ReminderCreateTool,
  RemindersReadTool,
} from "../../../../src/core/agent/tools/calendarTools.js";
import { LoopToolArgumentError } from "../../../../src/core/agent/tools/loopTool.js";
import * as config from "../../../../src/core/config.js";
import { LocalDateTime } from "../../../../src/core/util/localDateTime.js";

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

    await expect(tool.run(args)).rejects.toEqual(new LoopToolArgumentError(message));
    expect(store.readRanges).toEqual([]);
  });

  /** EventKit reads at most four years at once, dropping the rest unsaid: a longer range reads
   * nothing and the model is told to read it in parts; exactly the longest range is read whole. */
  test("a range longer than EventKit reads is refused", async () => {
    const tool = new CalendarReadTool(store, () => new Date());
    const longest = at(0, 0, config.calendarReadMaxDays);

    await expect(tool.run({ from_date: iso(day, false), to_date: iso(at(0, 1, config.calendarReadMaxDays)) })).rejects.toEqual(
      new LoopToolArgumentError(`A calendar is read at most ${config.calendarReadMaxDays} days at a time: read a longer range in parts.`),
    );
    expect(store.readRanges).toEqual([]);

    await tool.run({ from_date: iso(day, false), to_date: iso(longest) });
    expect(store.readRanges).toEqual([[day, longest]]);
  });

  /** Without access to Calendar, the tool fails saying where to allow it, which the model tells the
   * user. */
  test("no access says where to allow it", async () => {
    store.failure = new EventStoreFailure("calendarNoAccess");
    const tool = new CalendarReadTool(store, () => new Date());

    await expect(tool.run({})).rejects.toBe(store.failure);
    expect(new EventStoreFailure("calendarNoAccess").message).toContain("System Settings › Privacy & Security › Calendars");
    expect(new EventStoreFailure("remindersNoAccess").message).toContain("System Settings › Privacy & Security › Reminders");
    expect(new EventStoreFailure("noDefaultCalendar").message).toContain("Calendar's settings");
    expect(new EventStoreFailure("noDefaultList").message).toContain("Reminders' settings");
  });
});

describe("calendar_event_create", () => {
  /** The user is asked about the event as it will be added, every field it is added with shown, and it
   * is added as asked: with no end, it lasts the default hour. */
  test("an event is added as the user confirmed it", async () => {
    const tool = new CalendarEventCreateTool(store);
    const args = { title: " Launch review ", start_iso: iso(at(10)), location: "Room 4", notes: "Bring https://example.com/deck" };
    const end = new Date(at(10).getTime() + config.calendarEventDefaultDuration);

    const question = tool.confirmation(args);
    const result = await tool.run(args);

    expect(question).toBe(["Add this event to your calendar?", "Launch review", `${LocalDateTime.spoken(at(10))} to ${LocalDateTime.spoken(end)}`, "Room 4", "Bring https://example.com/deck"].join("\n"));
    expect(store.added).toEqual([{ title: "Launch review", start: at(10), end, isAllDay: false, calendar: "", location: "Room 4", notes: "Bring https://example.com/deck" }]);
    expect(result).toBe(`Added "Launch review" to the Work calendar: ${describeDate(at(10))} to ${describeDate(end)}.`);
  });

  /** A day for the start makes an all-day event, through the day `end_iso` names (its time ignored); `all_day` makes one
   * of a timed start; `end_iso` sets a timed event's end. */
  test("a day makes an all-day event", async () => {
    expect(CalendarEventCreateTool.draft({ title: "Offsite", start_iso: iso(day, false), end_iso: iso(at(0, 0, 2), false) })).toMatchObject({ isAllDay: true, start: day, end: at(0, 0, 2) });
    expect(CalendarEventCreateTool.draft({ title: "Holiday", start_iso: iso(at(9)), all_day: true })).toMatchObject({ isAllDay: true, start: day, end: day });
    expect(CalendarEventCreateTool.draft({ title: "Offsite", start_iso: iso(day, false), end_iso: iso(at(15, 0, 2)) })).toMatchObject({ isAllDay: true, start: day, end: at(0, 0, 2) });
    expect(CalendarEventCreateTool.draft({ title: "Call", start_iso: iso(at(9)), end_iso: iso(at(9, 30)) })).toMatchObject({ isAllDay: false, start: at(9), end: at(9, 30) });
    expect(CalendarEventCreateTool.draft({ title: "Call", start_iso: iso(day, false), all_day: false })).toMatchObject({ isAllDay: false, start: day });

    const tool = new CalendarEventCreateTool(store);
    const first = LocalDateTime.spoken(day, false);
    expect(tool.confirmation({ title: "Offsite", start_iso: iso(day, false) })).toBe(`Add this event to your calendar?\nOffsite\n${first}, all day`);
    expect(tool.confirmation({ title: "Offsite", start_iso: iso(day, false), end_iso: iso(at(0, 0, 2), false) })).toBe(
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

    expect(tool.confirmation(args)).toBeNull();
    await expect(tool.run(args)).rejects.toBeInstanceOf(LoopToolArgumentError);
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
    await expect(tool.run({ due_before: "soon" })).rejects.toBeInstanceOf(LoopToolArgumentError);
  });
});

describe("reminder_create", () => {
  /** The user is asked about the reminder as it will be added, every field it is added with shown (its
   * notes too), and it is added as asked; a day for `due_iso` is due that day, with no time. */
  test("a reminder is added as the user confirmed it", async () => {
    const tool = new ReminderCreateTool(store);
    const args = { title: "Send the deck", due_iso: iso(day, false), notes: "the short one" };

    const question = tool.confirmation(args);
    const result = await tool.run(args);

    expect(question).toBe(`Add this reminder?\nSend the deck\nDue ${LocalDateTime.spoken(day, false)}\nthe short one`);
    expect(store.addedReminders).toEqual([{ title: "Send the deck", list: "", due: day, dueHasTime: false, notes: "the short one" }]);
    expect(result).toBe(`Added "Send the deck" to the Reminders list, due ${describeDate(day, false)}.`);
    expect(tool.confirmation({ title: "Call back" })).toBe("Add this reminder?\nCall back");
  });

  /** A time for `due_iso` is due then, and says so. */
  test("a reminder due at a time", async () => {
    const tool = new ReminderCreateTool(store);
    const args = { title: "Call back", due_iso: iso(at(9)) };

    expect(tool.confirmation(args)).toBe(`Add this reminder?\nCall back\nDue ${LocalDateTime.spoken(at(9))}`);
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

    expect(tool.confirmation(args)).toBeNull();
    await expect(tool.run(args)).rejects.toBeInstanceOf(LoopToolArgumentError);
    expect(store.addedReminders).toEqual([]);
  });
});

describe("connectors", () => {
  /** Each app's switch covers its own tools, the reading one and the creating one, and only the
   * creating one asks first. */
  test("each app's switch covers its tools", () => {
    const tools = calendarTools(store);
    expect(tools.map((tool) => [tool.connector, tool.name])).toEqual([
      ["calendar", "calendar_read"],
      ["calendar", "calendar_event_create"],
      ["reminders", "reminders_read"],
      ["reminders", "reminder_create"],
    ]);
    const valid = { title: "Example", start_iso: iso(at(10)) };
    expect(tools.map((tool) => tool.confirmation(valid) !== null)).toEqual([false, true, false, true]);
  });
});
