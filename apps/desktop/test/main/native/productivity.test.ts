import { describe, expect, it, vi } from "vitest";
import { EventStoreError } from "../../../src/core/agent/connectors/calendar.js";
import { NativeContactStore, NativeEventStore, NativeNoteStore } from "../../../src/main/native/productivity.js";

const contact = { firstName: "Renée", lastName: "Synthetic", organization: "Voice", emails: ["test@example.invalid"], phones: [] };
describe("Native contacts boundary", () => {
  it("validates and returns the native bounded search", async () => {
    const run = vi.fn().mockResolvedValue([contact]);
    expect(await new NativeContactStore(run).search("Renée", 6)).toEqual([contact]);
    expect(run).toHaveBeenCalledWith("contactsSearch", { query: "Renée", limit: 6 });
  });
  it("does not retry an ambiguous create failure", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unavailable"));
    await expect(new NativeContactStore(run).add(contact)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, [contact, contact], [{ ...contact, emails: [42] }], [{ ...contact, firstName: "x\0y" }]])("refuses malformed/oversized replies", async (reply) => {
    await expect(new NativeContactStore(vi.fn().mockResolvedValue(reply)).search("test", 1)).rejects.toThrow();
  });
  it("refuses bad input before launching a process", async () => {
    const run = vi.fn();
    const store = new NativeContactStore(run);
    await expect(store.search("x\0y", 1)).rejects.toThrow();
    await expect(store.search("valid", 0)).rejects.toThrow();
    await expect(store.add({ ...contact, emails: ["a", "b"] })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Native Notes boundary", () => {
  const signal = new AbortController().signal;
  it("converts dates and forwards cancellation", async () => {
    const row = { title: "Memo", folder: "Personal", changed: 1000, text: "Body" };
    const run = vi.fn().mockResolvedValue([row]);
    expect(await new NativeNoteStore(run).search("Memo", signal)).toEqual([{ ...row, changed: new Date(1000) }]);
    expect(run).toHaveBeenCalledWith("notesSearch", { query: "Memo" }, signal);
  });
  it.each([null, [{ title: "Memo", folder: "Personal", changed: "invalid", text: "Body" }], [{ title: "Memo", folder: "Personal", changed: null, text: "x".repeat(32769) }]])("refuses malformed replies", async (result) => {
    await expect(new NativeNoteStore(vi.fn().mockResolvedValue(result)).search("Memo", signal)).rejects.toThrow();
  });
  it("passes only the confirmed draft to native create", async () => {
    const run = vi.fn().mockResolvedValue({ title: "Memo", folder: "Personal" });
    expect(await new NativeNoteStore(run).add("Memo", "Body", signal)).toEqual({ title: "Memo", folder: "Personal" });
    expect(run).toHaveBeenCalledWith("notesAdd", { title: "Memo", text: "Body" }, signal);
  });
});


describe("Native event store boundary", () => {
  const row = { title: "Task", list: "Personal", due: 1000, dueHasTime: true, notes: null };
  it("reads dated and undated tasks through the shared wire contract", async () => {
    const run = vi.fn().mockResolvedValue([row, { ...row, due: null, dueHasTime: false }]);
    const store = new NativeEventStore(run);
    expect(await store.openReminders(new Date(2000))).toEqual([{ ...row, due: new Date(1000) }, { ...row, due: null, dueHasTime: false }]);
    expect(run).toHaveBeenCalledWith("reminders", { dueBefore: 2000 });
  });
  it("writes only the approved fields to the default list", async () => {
    const run = vi.fn().mockResolvedValue(row);
    const draft = { ...row, due: new Date(1000) };
    expect(await new NativeEventStore(run).addReminder(draft)).toEqual(draft);
    expect(run).toHaveBeenCalledWith("reminderAdd", { title: "Task", due: 1000, dueHasTime: true, notes: null });
  });
  it.each([null, {}, [{ ...row, due: "1000" }], [{ ...row, due: null }], [{ ...row, list: "x\0y" }], Array(1001).fill(row)])("refuses malformed reminder replies", async (reply) => {
    await expect(new NativeEventStore(vi.fn().mockResolvedValue(reply)).openReminders(null)).rejects.toThrow();
  });
  it("rejects invalid dates before calling the provider and never retries writes", async () => {
    const run = vi.fn().mockRejectedValue(new Error("transport lost"));
    const store = new NativeEventStore(run);
    await expect(store.openReminders(new Date(NaN))).rejects.toThrow();
    await expect(store.addReminder({ ...row, due: null })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(store.addReminder({ ...row, due: new Date(1000) })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("converts and sorts calendar responses and excludes the caller's calendar on create", async () => {
    const event = { title: "Event", calendar: "Personal", start: 1000, end: 2000, isAllDay: false, location: null, notes: null };
    const run = vi.fn().mockResolvedValueOnce([{ ...event, start: 1500 }, event]).mockResolvedValueOnce(event);
    const store = new NativeEventStore(run);
    expect((await store.events(new Date(0), new Date(3000))).map(item => item.start.getTime())).toEqual([1000, 1500]);
    await store.addEvent({ ...event, start: new Date(1000), end: new Date(2000) });
    expect(run).toHaveBeenLastCalledWith("calendarAdd", { title: "Event", start: 1000, end: 2000, isAllDay: false, location: null, notes: null });
  });
  it("refuses inverted provider event dates", async () => {
    const event = { title: "Event", calendar: "Personal", start: 2000, end: 1000, isAllDay: false, location: null, notes: null };
    await expect(new NativeEventStore(vi.fn().mockResolvedValue([event])).events(new Date(0), new Date(3000))).rejects.toThrow();
  });
});

describe("Native event editor boundary (Linux)", () => {
  const start = Date.now() + 7 * 86_400_000;
  const weekly = { frequency: "WEEKLY" as const, interval: 1, count: 6, until: null, days: [{ weekday: 2, week: 0 }], monthDays: [], months: [], positions: [], yearWeeks: [], yearDays: [] };
  const row = {
    title: "Sync", calendar: "Personal", start, end: start + 3_600_000, isAllDay: false, location: null, notes: null,
    id: "system-calendar|uid-1", occurrence: start, calendarId: "system-calendar", availability: "free" as const,
    attendees: [{ email: "someone@example.com", name: "Someone", status: "pending" as const }], organizer: { email: "me@example.com", name: null, status: "unknown" as const },
    recurrence: weekly, isDetached: false, isInvitation: false, timeZone: "America/Toronto",
  };
  const converted = { ...row, start: new Date(start), end: new Date(start + 3_600_000), occurrence: new Date(start), recurrence: { ...weekly, until: null } };

  it("has an editor only where the helper can edit", () => {
    expect(new NativeEventStore(vi.fn()).editor).toBeUndefined();
    expect(new NativeEventStore(vi.fn(), "Local calendar").editor).toBeUndefined();
    expect(new NativeEventStore(vi.fn(), undefined, true).editor).toBeDefined();
  });
  it("reads rows with the fields the editor uses, dates converted", async () => {
    const until = start + 30 * 86_400_000;
    const run = vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce({ ...row, recurrence: { ...weekly, count: null, until } }).mockResolvedValueOnce(row);
    const store = new NativeEventStore(run, undefined, true);
    expect(await store.events(new Date(start - 1), new Date(start + 1))).toEqual([converted]);
    expect((await store.editor?.event(row.id, new Date(start)))?.recurrence?.until).toEqual(new Date(until));
    expect(run).toHaveBeenLastCalledWith("calendarEvent", { id: row.id, occurrence: start });
    await store.editor?.event(row.id, null);
    // The helper reads `occurrence` as a key that is there: null, never left out.
    expect(run.mock.lastCall?.[1]).toStrictEqual({ id: row.id, occurrence: null });
  });
  it("reads a single event on this computer: no id, occurrence, organizer, rule or zone", async () => {
    const single = { ...row, id: null, occurrence: null, organizer: null, recurrence: null, timeZone: null, calendarId: null, attendees: [] };
    const read = await new NativeEventStore(vi.fn().mockResolvedValue([single]), undefined, true).events(new Date(start - 1), new Date(start + 1));
    expect(read).toEqual([{ ...converted, id: null, occurrence: null, organizer: null, recurrence: null, timeZone: null, calendarId: null, attendees: [] }]);
  });
  it("reads up to 1000 people on an event, and refuses a row with more", async () => {
    const people = (count: number) => Array.from({ length: count }, (_, index) => ({ email: `person${index}@example.com`, name: null, status: "pending" }));
    const many = new NativeEventStore(vi.fn().mockResolvedValue([{ ...row, attendees: people(1000) }]), undefined, true);
    expect((await many.events(new Date(start - 1), new Date(start + 1)))[0]?.attendees).toHaveLength(1000);
    const tooMany = new NativeEventStore(vi.fn().mockResolvedValue([{ ...row, attendees: people(1001) }]), undefined, true);
    await expect(tooMany.events(new Date(start - 1), new Date(start + 1))).rejects.toThrow();
  });
  it("adds a single event to the default calendar with no rule and no people", async () => {
    const run = vi.fn().mockResolvedValue({ ...row, recurrence: null, occurrence: null, attendees: [] });
    await new NativeEventStore(run, undefined, true).addEvent({ ...converted, calendarId: null, recurrence: null, attendees: [] });
    expect(run).toHaveBeenCalledWith("calendarAdd", {
      title: "Sync", start, end: start + 3_600_000, isAllDay: false, location: null, notes: null, calendarId: null, availability: "free", recurrence: null, attendees: [],
    });
  });
  it("adds an event the create tool drafted with the base fields only, as busy, with no rule or people", async () => {
    const run = vi.fn().mockResolvedValue({ ...row, availability: "busy", recurrence: null, occurrence: null, attendees: [] });
    const { title, calendar, isAllDay, location, notes } = converted;
    await new NativeEventStore(run, undefined, true).addEvent({ title, calendar, start: converted.start, end: converted.end, isAllDay, location, notes });
    expect(run).toHaveBeenCalledWith("calendarAdd", {
      title: "Sync", start, end: start + 3_600_000, isAllDay: false, location: null, notes: null, calendarId: null, availability: "busy", recurrence: null, attendees: [],
    });
  });
  it.each([
    { attendees: [null] }, { organizer: "me@example.com" }, { recurrence: 5 }, { recurrence: { ...weekly, days: [null] } },
    { isInvitation: "no" }, { recurrence: { ...weekly, interval: 0 } }, { recurrence: { ...weekly, days: Array.from({ length: 367 }, () => ({ weekday: 2, week: 0 })) } },
    { recurrence: { ...weekly, days: [{ weekday: 0, week: 0 }] } }, { recurrence: { ...weekly, days: [{ weekday: 2, week: 1.5 }] } },
    { recurrence: { ...weekly, monthDays: Array.from({ length: 367 }, () => 1) } }, { calendarId: "x\0y" }, { recurrence: { ...weekly, count: null, until: "soon" } },
    { availability: "tentative" }, { attendees: [{ email: "a@example.com", name: null, status: "maybe" }] }, { organizer: { email: 4 } },
    { recurrence: { ...weekly, frequency: "HOURLY" } }, { recurrence: { ...weekly, count: 0 } }, { recurrence: { ...weekly, days: [{ weekday: 8, week: 0 }] } },
    { recurrence: { ...weekly, monthDays: [1.5] } }, { isDetached: "no" }, { id: "x\0y" }, { occurrence: "soon" }, { timeZone: 5 },
    { attendees: {} }, { recurrence: { ...weekly, days: {} } }, { recurrence: { ...weekly, monthDays: {} } },
    { attendees: [{ email: 4, name: null, status: "accepted" }] },
  ])("refuses a malformed editor row", async (change) => {
    await expect(new NativeEventStore(vi.fn().mockResolvedValue([{ ...row, ...change }]), undefined, true).events(new Date(start - 1), new Date(start + 1))).rejects.toThrow(/native data service/u);
  });
  it("turns a helper's refusal into the store's error, and nothing else", async () => {
    const editor = new NativeEventStore(vi.fn().mockResolvedValue({ refused: "notOrganizer" }), undefined, true).editor;
    await expect(editor?.edit(row.id, null, "all", { title: "New", invite: [], uninvite: [], exclude: [] })).rejects.toThrow(new EventStoreError("notOrganizer"));
    const unsupported = new NativeEventStore(vi.fn().mockResolvedValue({ refused: "unsupportedRecurrence" }), undefined, true).editor;
    await expect(unsupported?.delete(row.id)).rejects.toThrow(new EventStoreError("unsupportedRecurrence"));
    const unknown = new NativeEventStore(vi.fn().mockResolvedValue({ refused: "somethingElse" }), undefined, true);
    await expect(unknown.editor?.delete(row.id)).rejects.toThrow(/native data service/u);
    await expect(unknown.addEvent({ ...converted })).rejects.not.toBeInstanceOf(EventStoreError);
    const noCalendar = new NativeEventStore(vi.fn().mockResolvedValue({ refused: "noSuchCalendar" }), undefined, true);
    await expect(noCalendar.addEvent({ ...converted, calendarId: "missing" })).rejects.toThrow(new EventStoreError("noSuchCalendar"));
  });
  it("adds with the calendar, availability, rule and people where it can edit", async () => {
    const run = vi.fn().mockResolvedValue(row);
    const until = new Date(start + 30 * 86_400_000);
    await new NativeEventStore(run, undefined, true).addEvent({ ...converted, recurrence: { ...weekly, count: null, until } });
    expect(run).toHaveBeenCalledWith("calendarAdd", {
      title: "Sync", start, end: start + 3_600_000, isAllDay: false, location: null, notes: null, calendarId: "system-calendar", availability: "free",
      recurrence: { ...weekly, count: null, until: until.getTime() }, attendees: [{ email: "someone@example.com", name: "Someone" }],
    });
    const plain = vi.fn().mockResolvedValue({ title: "Sync", calendar: "Personal", start, end: start, isAllDay: false, location: null, notes: null });
    await new NativeEventStore(plain).addEvent({ ...converted, end: new Date(start) });
    expect(plain).toHaveBeenCalledWith("calendarAdd", { title: "Sync", start, end: start, isAllDay: false, location: null, notes: null });
  });
  it("sends every field an edit changes, as the helper reads them", async () => {
    const run = vi.fn().mockResolvedValue(row);
    await new NativeEventStore(run, undefined, true).editor?.edit(row.id, null, "all", {
      title: "Planning", start: new Date(start + 60_000), end: new Date(start + 120_000), isAllDay: true, location: "Room 4", notes: "Agenda",
      availability: "busy", invite: [], uninvite: [], exclude: [],
    });
    expect(run.mock.lastCall?.[1]).toStrictEqual({ id: row.id, occurrence: null, scope: "all", title: "Planning", start: start + 60_000, end: start + 120_000,
      isAllDay: true, location: "Room 4", notes: "Agenda", availability: "busy", invite: [], uninvite: [], exclude: [] });
  });
  it("reads every answer an attendee can give", async () => {
    const answers = ["accepted", "declined", "tentative", "pending", "unknown"] as const;
    const run = vi.fn().mockResolvedValue([{ ...row, attendees: answers.map((status, index) => ({ email: `person${index}@example.com`, name: null, status })) }]);
    const [read] = await new NativeEventStore(run, undefined, true).events(new Date(start - 1), new Date(start + 1));
    expect(read?.attendees?.map((person) => person.status)).toEqual(answers);
  });
  it("sends an edit's changes, keeping, ending or setting the rule", async () => {
    const run = vi.fn().mockResolvedValue(row);
    const editor = new NativeEventStore(run, undefined, true).editor;
    const changes = { start: new Date(start + 60_000), end: new Date(start + 120_000), invite: [{ email: "new@example.com", name: null, status: "pending" }], uninvite: ["old@example.com"], exclude: [new Date(start + 7 * 86_400_000)] };
    await editor?.edit(row.id, new Date(start), "thisAndFollowing", changes);
    expect(run).toHaveBeenLastCalledWith("calendarEdit", { id: row.id, occurrence: start, scope: "thisAndFollowing", start: start + 60_000, end: start + 120_000,
      invite: [{ email: "new@example.com", name: null }], uninvite: ["old@example.com"], exclude: [start + 7 * 86_400_000] });
    expect(JSON.stringify(run.mock.lastCall?.[1])).not.toContain("recurrence");
    await editor?.edit(row.id, null, "all", { recurrence: null, invite: [], uninvite: [], exclude: [] });
    expect(run.mock.lastCall?.[1]).toMatchObject({ recurrence: null, occurrence: null });
    await editor?.edit(row.id, null, "all", { recurrence: { ...weekly, until: null }, invite: [], uninvite: [], exclude: [] });
    expect(run.mock.lastCall?.[1]).toMatchObject({ recurrence: weekly });
  });
  it("lists calendars and deletes by id", async () => {
    const calendars = [{ id: "system-calendar", title: "Personal", account: "On This Computer", isDefault: true }, { id: "work", title: "Work", account: "Office", isDefault: false }];
    const run = vi.fn().mockResolvedValueOnce(calendars).mockResolvedValueOnce({}).mockResolvedValueOnce([{ ...calendars[0], isDefault: "yes" }]).mockResolvedValueOnce([null])
      .mockResolvedValueOnce([{ ...calendars[0], id: "x\0y" }]).mockResolvedValueOnce([{ ...calendars[0], title: 4 }]).mockResolvedValueOnce([{ ...calendars[0], account: 4 }]);
    const editor = new NativeEventStore(run, undefined, true).editor;
    expect(await editor?.calendars()).toEqual(calendars);
    await editor?.delete(row.id);
    expect(run).toHaveBeenLastCalledWith("calendarDelete", { id: row.id });
    for (let refused = 0; refused < 5; refused += 1) await expect(editor?.calendars()).rejects.toThrow(/native data service/u);
  });
});
