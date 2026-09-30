// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The dates the Answer prompt's tools take and give: ISO 8601 without a UTC offset, in the user's
 * time zone ("2025-01-15", "2025-01-15T14:00", "2025-01-15T14:00:00"), as the backend's tool
 * definitions describe them. The user's zone is this computer's, the one `Date`'s local fields use.
 */
export const LocalDateTime = {
  /** `text` as a local date, and whether it named a time of day; null when it isn't one of the forms
   * above or names no such day or time. */
  parse(text: string): { date: Date; hasTime: boolean } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());
    if (!match) return null;
    const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match.slice(1).map((field) => (field === undefined ? 0 : Number(field)));
    const hasTime = match[4] !== undefined;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const date = new Date(year, month - 1, day, hour, minute, second);
    // `Date` rolls an impossible day over into the next month; there is no such day.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return { date, hasTime };
  },

  /** `date` as the model reads it: "Fri 2025-01-17 14:00", or "Fri 2025-01-17" for a day. */
  describe(date: Date, withTime = true): string {
    const day = `${weekdays[date.getDay()]} ${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
    return withTime ? `${day} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}` : day;
  },

  /** `date` as the user reads it in a question to confirm: their locale's full date and short time. */
  spoken(date: Date, withTime = true): string {
    return date.toLocaleString(undefined, withTime ? { dateStyle: "full", timeStyle: "short" } : { dateStyle: "full" });
  },

  startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  },

  /** `date` `days` calendar days on, at the same time of day (across a daylight-saving change too). */
  addingDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  },
};

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
