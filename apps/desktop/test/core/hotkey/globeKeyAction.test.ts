// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { GlobeKeyAction, type GlobeKeySystem, savedChoiceKey } from "../../../src/core/hotkey/globeKeyAction.js";
import type { DictationHotkey } from "../../../src/core/hotkey/bindings.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";

/** `AppleFnUsageType`'s Do Nothing, as the system defines it: not the app's own constant, so a
 * wrong one fails here. */
const doNothing = 0;
/** Change Input Source, a choice other than Do Nothing. */
const changeInputSource = 1;
/** Show Emoji & Symbols, another. */
const showEmoji = 2;

/** Keyboard settings' "Press 🌐 key to", as the system holds it; `available: false` is a macOS
 * without the calls. */
class Setting implements GlobeKeySystem {
  readonly updates: number[] = [];
  constructor(
    public value: number,
    private readonly available = true,
  ) {}

  async read(): Promise<number | null> {
    return this.available ? this.value : null;
  }

  async update(value: number): Promise<void> {
    if (!this.available) throw new Error("TISUpdateFnUsageType unavailable");
    this.value = value;
    this.updates.push(value);
  }
}

/** The Globe key's own action while fn is the hotkey (ADR-DESK-031): off meanwhile, the user's
 * choice back afterwards. Against a stand-in for the system setting; no test changes the real one. */
describe("GlobeKeyAction", () => {
  test("fn as the hotkey turns the Globe action off and another key puts it back", async () => {
    const setting = new Setting(changeInputSource);
    const store = new MemoryStore();
    const globe = new GlobeKeyAction(setting, store);

    await globe.hotkeyIs("function");
    expect(setting.value).toBe(doNothing);
    await globe.hotkeyIs("function");
    expect(setting.updates).toEqual([doNothing]);

    await globe.hotkeyIs("rightOption");
    expect(setting.value).toBe(changeInputSource);
    expect(store.get(savedChoiceKey)).toBeUndefined();
  });

  test("quitting puts the choice back", async () => {
    const setting = new Setting(showEmoji);
    const globe = new GlobeKeyAction(setting, new MemoryStore());

    await globe.hotkeyIs("function");
    await globe.restore();

    expect(setting.value).toBe(showEmoji);
    expect(setting.updates).toEqual([doNothing, showEmoji]);
  });

  /** Changes made in quick succession run in order: the last hotkey wins. */
  test("calls made without waiting run in order", async () => {
    const setting = new Setting(changeInputSource);
    const globe = new GlobeKeyAction(setting, new MemoryStore());

    void globe.hotkeyIs("function");
    void globe.hotkeyIs("rightOption");
    await globe.hotkeyIs("function");

    expect(setting.updates).toEqual([doNothing, changeInputSource, doNothing]);
  });

  /** Right Option as the hotkey, or a user who chose Do Nothing themselves: the setting is never
   * touched. */
  test.each<[DictationHotkey, number]>([
    ["rightOption", changeInputSource],
    ["function", doNothing],
  ])("leaves the setting alone when there is nothing to turn off (%s, %i)", async (hotkey, value) => {
    const setting = new Setting(value);
    const globe = new GlobeKeyAction(setting, new MemoryStore());

    await globe.hotkeyIs(hotkey);
    await globe.hotkeyIs("rightOption");
    await globe.restore();

    expect(setting.updates).toEqual([]);
    expect(setting.value).toBe(value);
  });

  /** The user picked another action in Keyboard settings while fn was the hotkey: theirs stays. */
  test("a choice made meanwhile is kept", async () => {
    const setting = new Setting(changeInputSource);
    const store = new MemoryStore();
    const globe = new GlobeKeyAction(setting, store);

    await globe.hotkeyIs("function");
    setting.value = showEmoji;
    await globe.hotkeyIs("rightOption");

    expect(setting.value).toBe(showEmoji);
    expect(store.get(savedChoiceKey)).toBeUndefined();
  });

  /** A run that ended without quitting (a crash) left the setting at Do Nothing: the next launch
   * puts the choice back if fn is no longer the hotkey, and keeps holding it if it is. */
  test("the next launch puts right a run that crashed", async () => {
    const setting = new Setting(changeInputSource);
    const store = new MemoryStore();
    await new GlobeKeyAction(setting, store).hotkeyIs("function");

    await new GlobeKeyAction(setting, store).hotkeyIs("function");
    expect(setting.value).toBe(doNothing);

    await new GlobeKeyAction(setting, store).hotkeyIs("rightOption");
    expect(setting.value).toBe(changeInputSource);
  });

  /** Between the crash and the next launch, with fn still the hotkey, the user picked another
   * action: that is the choice to put back later. */
  test("a choice made while the app was not running is the one kept", async () => {
    const setting = new Setting(changeInputSource);
    const store = new MemoryStore();
    await new GlobeKeyAction(setting, store).hotkeyIs("function");
    setting.value = showEmoji;

    const globe = new GlobeKeyAction(setting, store);
    await globe.hotkeyIs("function");
    expect(setting.value).toBe(doNothing);
    await globe.restore();

    expect(setting.value).toBe(showEmoji);
  });

  /** A choice saved by a run that crashed, on a macOS that has since dropped the calls: it cannot be
   * put back, and is forgotten rather than kept for ever. */
  test("a saved choice the system can no longer take is forgotten", async () => {
    const store = new MemoryStore({ [savedChoiceKey]: changeInputSource });
    await new GlobeKeyAction(new Setting(doNothing, false), store).restore();
    expect(store.get(savedChoiceKey)).toBeUndefined();
  });

  /** Without the system calls nothing is changed or saved. */
  test("without the system calls nothing is saved", async () => {
    const store = new MemoryStore();
    const globe = new GlobeKeyAction(new Setting(changeInputSource, false), store);
    await globe.hotkeyIs("function");
    expect(store.get(savedChoiceKey)).toBeUndefined();
    await globe.restore();
  });

  /** The choice is saved before the setting changes, and forgotten only after it is put back: a
   * crash at any point still knows the way back. */
  test("the choice is saved whenever the setting is Do Nothing because of the app", async () => {
    const store = new MemoryStore();
    const savedAtEachUpdate: unknown[] = [];
    const setting = new Setting(changeInputSource);
    const system: GlobeKeySystem = {
      read: () => setting.read(),
      update: async (value) => {
        savedAtEachUpdate.push(store.get(savedChoiceKey));
        await setting.update(value);
      },
    };
    const globe = new GlobeKeyAction(system, store);

    await globe.hotkeyIs("function");
    await globe.restore();

    expect(savedAtEachUpdate).toEqual([changeInputSource, changeInputSource]);
    expect(store.get(savedChoiceKey)).toBeUndefined();
  });

  /** A helper that fails a call does not stop later calls. */
  test("a failed call leaves the queue running", async () => {
    let fail = true;
    const setting = new Setting(changeInputSource);
    const system: GlobeKeySystem = {
      read: async () => {
        if (fail) throw new Error("helper restarting");
        return setting.read();
      },
      update: (value) => setting.update(value),
    };
    const globe = new GlobeKeyAction(system, new MemoryStore());

    await globe.hotkeyIs("function");
    fail = false;
    await globe.hotkeyIs("function");

    expect(setting.value).toBe(doNothing);
  });
});
