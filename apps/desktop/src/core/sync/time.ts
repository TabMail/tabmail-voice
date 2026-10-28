// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** When a text synced by Device Sync last changed: an ISO 8601 time in UTC ("…Z"), compared as a
 * string, as Thunderbird and iOS compare it. */

/** The time of a text never edited, or reset: Thunderbird's and iOS's epoch zero, which they never let
 * overwrite another device's text. */
export const epochZero = "1970-01-01T00:00:00.000Z";

/** Just after epoch zero: the time a merge ancestor is sent with. Every device that has synced holds a
 * later ancestor and skips it; one that never synced keeps its own edited text and takes it as the
 * common ancestor for the next merge, and one with only its defaults takes it. */
export const ancestorTime = "1970-01-01T00:00:00.001Z";

const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** The last time an ISO string of four digits of year can say. */
const latest = Date.parse("9999-12-31T23:59:59.999Z");

/** Whether `value` is such a time. */
export function isSyncTime(value: unknown): value is string {
  return typeof value === "string" && isoTime.test(value) && Number.isFinite(Date.parse(value));
}

/** The time to stamp a change with: now, or just after the latest of `after` when this computer's
 * clock is behind it, so another device never takes the change for one it already has. */
export function nextSyncTime(now: number, after: readonly string[]): string {
  const times = after.map((time) => Date.parse(time)).filter((time) => Number.isFinite(time));
  return new Date(Math.min(latest, Math.max(now, ...times.map((time) => time + 1)))).toISOString();
}
