import { describe, expect, it, vi } from "vitest";
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
