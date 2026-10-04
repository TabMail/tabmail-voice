// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { execFile } from "node:child_process";
import type { CalendarEvent, EventStore, ReminderItem } from "../../core/agent/connectors/calendar.js";
import type { ContactCard, ContactStore } from "../../core/agent/connectors/contacts.js";

import type { NoteItem, NoteStore } from "../../core/agent/connectors/notes.js";

export type ProductivityRunner = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
const failure = (): Error => new Error("The native data service couldn't complete the request. Check that the relevant account or local store is available. If you were adding an item, check the store before trying again.");

/** Disposable native process, separate from real-time input/audio. Never retry writes. */
export const productivityRunner = (executable: string): ProductivityRunner => (method, params, signal) => new Promise((resolve, reject) => {
  const input = JSON.stringify({ method, params }) + "\n";
  if (Buffer.byteLength(input) > 256 * 1024) { reject(failure()); return; }
  const child = execFile(executable, [], { encoding: "utf8", windowsHide: true, timeout: 30_000, signal, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) { reject(failure()); return; }
    try { resolve(JSON.parse(stdout)); }
    catch { reject(failure()); }
  });
  child.stdin?.on("error", () => { /* Completion reports the sanitized error. */ });
  child.stdin?.end(input);
});

function card(value: unknown): ContactCard {
  if (!value || typeof value !== "object") throw failure();
  const row = value as Record<string, unknown>;
  const text = (item: unknown): item is string => typeof item === "string" && Buffer.byteLength(item) <= 32768 && !item.includes("\0");
  const list = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 100 && item.every(text);
  if (!text(row.firstName) || !text(row.lastName) || !text(row.organization) || !list(row.emails) || !list(row.phones)) throw failure();
  return { firstName: row.firstName, lastName: row.lastName, organization: row.organization, emails: row.emails, phones: row.phones };
}

export class NativeContactStore implements ContactStore {
  constructor(private readonly runner: ProductivityRunner, readonly writeDestination?: string) {}
  async search(query: string, limit: number): Promise<ContactCard[]> {
    if (!query || Buffer.byteLength(query) > 32768 || query.includes("\0") || !Number.isInteger(limit) || limit < 1 || limit > 100) throw failure();
    const result = await this.runner("contactsSearch", { query, limit });
    if (!Array.isArray(result) || result.length > limit) throw failure();
    return result.map(card);
  }
  async add(contact: ContactCard): Promise<ContactCard> {
    const validated = card(contact);
    if (validated.emails.length > 1 || validated.phones.length > 1) throw failure();
    return card(await this.runner("contactsAdd", { ...validated }));
  }
}

export class NativeNoteStore implements NoteStore {
  constructor(private readonly runner: ProductivityRunner) {}
  async search(query: string, signal: AbortSignal): Promise<NoteItem[]> {
    const result = await this.runner("notesSearch", { query }, signal);
    if (!Array.isArray(result) || result.length > 1000) throw failure();
    return result.map((value: unknown) => {
      if (!value || typeof value !== "object") throw failure();
      const row = value as Record<string, unknown>;
      for (const key of ["title", "folder", "text"] as const) {
        if (typeof row[key] !== "string" || Buffer.byteLength(row[key]) > 32768 || row[key].includes("\0")) throw failure();
      }
      if (row.changed !== null && (typeof row.changed !== "number" || !Number.isSafeInteger(row.changed) || !Number.isFinite(new Date(row.changed).getTime()))) throw failure();
      return { title: row.title as string, folder: row.folder as string, text: row.text as string, changed: row.changed === null ? null : new Date(row.changed as number) };
    });
  }
  async add(title: string, text: string, signal: AbortSignal): Promise<{ title: string; folder?: string }> {
    const result = await this.runner("notesAdd", { title, text }, signal);
    if (!result || typeof result !== "object") throw failure();
    const row = result as Record<string, unknown>;
    if (typeof row.title !== "string" || typeof row.folder !== "string" || row.title !== title || Buffer.byteLength(row.folder) > 32768 || row.folder.includes("\0")) throw failure();
    return { title: row.title, folder: row.folder };
  }
}

function providerText(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 32768 || value.includes("\0")) throw failure();
  return value;
}
function providerDate(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -2208988800000 || value > 253402300799000) throw failure();
  return new Date(value);
}
function reminderRow(value: unknown): ReminderItem {
  if (!value || typeof value !== "object") throw failure();
  const row = value as Record<string, unknown>;
  if (typeof row.dueHasTime !== "boolean" || (row.due === null && row.dueHasTime)) throw failure();
  return { title: providerText(row.title), list: providerText(row.list), due: row.due === null ? null : providerDate(row.due),
    dueHasTime: row.dueHasTime, notes: row.notes === null ? null : providerText(row.notes) };
}
function eventRow(value: unknown): CalendarEvent {
  if (!value || typeof value !== "object") throw failure();
  const row = value as Record<string, unknown>;
  if (typeof row.isAllDay !== "boolean") throw failure();
  const start = providerDate(row.start), end = providerDate(row.end);
  if (end < start) throw failure();
  return { title: providerText(row.title), calendar: providerText(row.calendar), start, end, isAllDay: row.isAllDay,
    location: row.location === null ? null : providerText(row.location), notes: row.notes === null ? null : providerText(row.notes) };
}
function providerRows<T>(value: unknown, convert: (row: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 1000) throw failure();
  return value.map(convert);
}

/** Native providers use the same millisecond wire contract as EventKit. */
export class NativeEventStore implements EventStore {
  constructor(private readonly runner: ProductivityRunner, readonly calendarWriteDestination?: string) {}
  async events(start: Date, end: Date): Promise<CalendarEvent[]> {
    const from = providerDate(start.getTime()), to = providerDate(end.getTime());
    if (to <= from) throw failure();
    const rows = providerRows(await this.runner("calendarEvents", { start: from.getTime(), end: to.getTime() }), eventRow);
    return rows.sort((a, b) => a.start.getTime() - b.start.getTime());
  }
  async addEvent(event: CalendarEvent): Promise<CalendarEvent> {
    const draft = { ...event, start: event.start.getTime(), end: event.end.getTime() };
    eventRow(draft);
    const { title, start, end, isAllDay, location, notes } = draft;
    return eventRow(await this.runner("calendarAdd", { title, start, end, isAllDay, location, notes }));
  }
  async openReminders(dueBefore: Date | null): Promise<ReminderItem[]> {
    const before = dueBefore === null ? null : providerDate(dueBefore.getTime()).getTime();
    return providerRows(await this.runner("reminders", { dueBefore: before }), reminderRow);
  }
  async addReminder(reminder: ReminderItem): Promise<ReminderItem> {
    const draft = { ...reminder, due: reminder.due?.getTime() ?? null };
    reminderRow(draft);
    const { title, due, dueHasTime, notes } = draft;
    return reminderRow(await this.runner("reminderAdd", { title, due, dueHasTime, notes }));
  }
}
