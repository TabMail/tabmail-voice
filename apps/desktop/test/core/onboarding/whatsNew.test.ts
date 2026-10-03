// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { takeWhatsNew, type WhatsNewEntry, whatsNewEntries } from "../../../src/core/onboarding/whatsNew.js";
import { AppSettings } from "../../../src/core/settings.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";

const first: WhatsNewEntry = { id: "first", title: "First", detail: "The first change." };
const second: WhatsNewEntry = { id: "second", title: "Second", detail: "The second change." };

function settings(store = new MemoryStore(), finishedWelcome = true): AppSettings {
  const app = new AppSettings(store, () => false);
  app.hasFinishedWelcome = finishedWelcome;
  return app;
}

describe("takeWhatsNew", () => {
  test("a user who set the app up before is told about a change once, across launches", () => {
    const store = new MemoryStore();
    expect(takeWhatsNew(settings(store), [first])).toEqual([first]);
    expect(takeWhatsNew(settings(store), [first])).toEqual([]);
  });

  test("a change added later is told about on its own", () => {
    const store = new MemoryStore();
    takeWhatsNew(settings(store), [first]);
    expect(takeWhatsNew(settings(store), [first, second])).toEqual([second]);
  });

  /** The welcome wizard's consent page already says it, so a new user isn't told again once set up. */
  test("a user still in the welcome wizard is told nothing, then or after finishing it", () => {
    const store = new MemoryStore();
    expect(takeWhatsNew(settings(store, false), [first])).toEqual([]);
    expect(takeWhatsNew(settings(store, true), [first])).toEqual([]);
  });

  test("a stored list that isn't one is read as nothing seen", () => {
    const store = new MemoryStore({ whatsNewSeen: "first" });
    expect(takeWhatsNew(settings(store), [first])).toEqual([first]);
    expect(new AppSettings(new MemoryStore({ whatsNewSeen: ["first", 3] }), () => false).whatsNewSeen).toEqual(["first"]);
  });

  test("the app's entries each have their own id", () => {
    const ids = whatsNewEntries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("longDictations");
  });
});
