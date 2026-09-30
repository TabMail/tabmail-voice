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
