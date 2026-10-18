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

  /** `date` in the form the tools take it back in: "2025-01-17T14:00:00". */
  iso(date: Date): string {
    const day = `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
    return `${day}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
  },

  /** `date` as the user reads it in a question to confirm: their locale's full date and short time. */
  spoken(date: Date, withTime = true): string {
    return date.toLocaleString(undefined, withTime ? { dateStyle: "full", timeStyle: "short" } : { dateStyle: "full" });
  },

  /** `date`'s day as a calendar page shows it: "Oct", 21 and "Wed". A card's dates are English and
   * Gregorian, the only language and calendar the app supports, so the page, the day and the year
   * check all count the same calendar. */
  page(date: Date): { month: string; day: number; weekday: string } {
    return { month: date.toLocaleString(cardLocale, { month: "short" }), day: date.getDate(), weekday: date.toLocaleString(cardLocale, { weekday: "short" }) };
  },

  /** From `start` to `end` as a question's card shows it: the times alone
   * ("10:00 – 11:00 AM"), or with their days ("Thu, Oct 22, 3:00 PM – Fri, Oct 23, 9:00 AM"). A day
   * outside this year always shows, with its year: the card is what the user confirms by click. */
  timeRange(start: Date, end: Date, withDays: boolean): string {
    const time = { hour: "numeric", minute: "2-digit" } as const;
    const year = yearOf(start, end);
    return new Intl.DateTimeFormat(cardLocale, withDays || year.year ? { weekday: "short", month: "short", day: "numeric", ...year, ...time } : time).formatRange(start, end);
  },

  /** The days from `first` to `last` as a question's card shows them: "Oct 21",
   * or "Oct 21 – 23", with the year when one is outside this year ("Jan 5, 2027"). */
  dayRange(first: Date, last: Date): string {
    return new Intl.DateTimeFormat(cardLocale, { month: "short", day: "numeric", ...yearOf(first, last) }).formatRange(first, last);
  },

  /** `date` as a question's card names one day: "Thu, Oct 22", with its time
   * ("Thu, Oct 22, 3:00 PM") for a timed event's occurrence, and its year when it isn't this year. */
  shortDay(date: Date, withTime: boolean): string {
    return date.toLocaleString(cardLocale, { weekday: "short", month: "short", day: "numeric", ...yearOf(date), ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) });
  },

  /** Whether `date` is in this year, when a question's card can leave its year out. */
  inThisYear(date: Date): boolean {
    return date.getFullYear() === new Date().getFullYear();
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

/** The language a question's card writes its dates in, with the Gregorian calendar it uses. */
const cardLocale = "en-US";

/** The year option a card's date takes: none when every date is in this year. */
function yearOf(...dates: Date[]): { year?: "numeric" } {
  return dates.every((date) => LocalDateTime.inThisYear(date)) ? {} : { year: "numeric" };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
