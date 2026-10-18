// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A zone with daylight saving, set before any date is made (each test file runs in its own process).
process.env.TZ = "America/New_York";

import { expect, test } from "vitest";
import { LocalDateTime } from "../../../src/core/util/localDateTime.js";

/** The next day, from today, whose local length is not 24 hours: a daylight-saving change. */
function nextClockChange(): Date {
  const today = new Date();
  for (let offset = 0; offset < 400; offset += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset + 1);
    if (next.getTime() - day.getTime() !== 24 * 3600 * 1000) return day;
  }
  throw new Error("no daylight-saving change within 400 days");
}

/** A day later is the next calendar day at the same time, across a daylight-saving change too: "from
 * noon, a day on" is noon the next day, never 11:00 or 13:00. */
test("a day later keeps the time across a daylight-saving change", () => {
  const change = nextClockChange();
  const noon = new Date(change.getFullYear(), change.getMonth(), change.getDate(), 12);

  const later = LocalDateTime.addingDays(noon, 1);

  expect([later.getDate(), later.getHours()]).toEqual([new Date(change.getFullYear(), change.getMonth(), change.getDate() + 1).getDate(), 12]);
  expect(LocalDateTime.addingDays(LocalDateTime.startOfDay(noon), 1)).toEqual(new Date(change.getFullYear(), change.getMonth(), change.getDate() + 1));
});

/** An occurrence's id is its start to the second, as the tools take it back: a time with seconds
 * keeps them, so it names the same occurrence. */
test("iso keeps the seconds, and reads back as the same time", () => {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  date.setHours(9, 5, 7, 0);
  const iso = LocalDateTime.iso(date);

  expect(iso).toMatch(/T09:05:07$/u);
  expect(LocalDateTime.parse(iso)?.date.getTime()).toBe(date.getTime());
});

const englishWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A question's card names days in English on the Gregorian calendar, whatever the computer's
 * language: the page is the date's day of the month with its short month and weekday. */
test("a calendar page shows the date's day, month and weekday", () => {
  const year = new Date().getFullYear();
  const first = new Date(year, 5, 10, 9, 47);
  const second = new Date(year, 9, 21, 9, 47);

  expect(LocalDateTime.page(first)).toEqual({ month: "Jun", day: 10, weekday: englishWeekdays[first.getDay()] });
  expect(LocalDateTime.page(second)).toEqual({ month: "Oct", day: 21, weekday: englishWeekdays[second.getDay()] });
});

/** A card's times show their minutes, and their days only when asked or when a day is outside this
 * year; a day's time shows only when asked; a range of days names both. */
test("a card's times and days show what they are asked to, with a year outside this one", () => {
  const year = new Date().getFullYear();
  const yearText = (value: number) => String(value);
  const start = new Date(year, 5, 10, 9, 47);
  const end = new Date(year, 5, 10, 9, 52);
  const nextDay = new Date(year, 5, 11, 9, 52);
  const month = "Jun";

  // The whole time, hours and minutes and morning or afternoon, in English.
  const spaced = (text: string) => text.replace(/\s/gu, " ");
  expect(spaced(LocalDateTime.timeRange(start, new Date(year, 5, 10, 10, 52), false))).toBe("9:47 – 10:52 AM");
  expect(spaced(LocalDateTime.timeRange(new Date(year, 5, 10, 11, 30), new Date(year, 5, 10, 13, 5), false))).toBe("11:30 AM – 1:05 PM");
  expect(spaced(LocalDateTime.timeRange(new Date(year, 5, 10, 23), new Date(year, 5, 11, 1), true))).toBe(`${englishWeekdays[start.getDay()]}, Jun 10, 11:00 PM – ${englishWeekdays[nextDay.getDay()]}, Jun 11, 1:00 AM`);
  expect(spaced(LocalDateTime.shortDay(start, true))).toBe(`${englishWeekdays[start.getDay()]}, Jun 10, 9:47 AM`);
  const times = LocalDateTime.timeRange(start, end, false);
  expect(times).toContain("47");
  expect(times).toContain("52");
  expect(times).not.toContain(month);
  expect(times).not.toContain(yearText(year));
  const days = LocalDateTime.timeRange(start, nextDay, true);
  expect(days).toContain(month);
  expect(days).toContain("10");
  expect(days).toContain("11");
  expect(days).not.toContain(yearText(year));

  expect(LocalDateTime.shortDay(start, true)).toContain("47");
  expect(LocalDateTime.shortDay(start, false)).not.toContain("47");
  expect(LocalDateTime.shortDay(start, false)).toContain(month);
  expect(LocalDateTime.dayRange(start, new Date(year, 5, 12))).toContain("12");
  expect(LocalDateTime.dayRange(start, start)).not.toContain("12");

  const later = new Date(year + 1, 0, 5, 9, 47);
  const earlier = new Date(year - 1, 5, 10);
  expect(LocalDateTime.timeRange(later, new Date(later.getTime() + 5 * 60 * 1000), false)).toContain(yearText(year + 1));
  expect(LocalDateTime.timeRange(later, new Date(later.getTime() + 5 * 60 * 1000), false)).toContain("Jan 5");
  expect(LocalDateTime.shortDay(earlier, false)).toContain(yearText(year - 1));
  expect(LocalDateTime.dayRange(earlier, earlier)).toContain(yearText(year - 1));
  expect(LocalDateTime.dayRange(new Date(year, 11, 30), later)).toContain(yearText(year + 1));
  expect([LocalDateTime.inThisYear(start), LocalDateTime.inThisYear(later), LocalDateTime.inThisYear(earlier)]).toEqual([true, false, false]);
});
