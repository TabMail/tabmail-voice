// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../src/core/config.js";
import { type UpdateSource, Updater } from "../src/main/updater.js";

type CheckResult = Awaited<ReturnType<UpdateSource["checkForUpdates"]>>;

/** `electron-updater` as `Updater` sees it: a check runs `answer`, which emits what the real one
 * would (`update-available` before the result resolves). */
class FakeSource extends EventEmitter implements UpdateSource {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs = 0;
  answer: () => Promise<CheckResult> = () => Promise.resolve(null);

  checkForUpdates(): Promise<CheckResult> {
    this.checks += 1;
    return this.answer();
  }

  quitAndInstall(): void {
    this.installs += 1;
  }

  /** The next check finds `version`, which downloads until `downloaded()`. */
  finds(version: string): void {
    this.answer = () => {
      this.emit("update-available", { version });
      return Promise.resolve({ isUpdateAvailable: true, downloadPromise: new Promise(() => {}) });
    };
  }

  upToDate(): void {
    this.answer = () => Promise.resolve({ isUpdateAvailable: false });
  }

  fails(): void {
    this.answer = () => {
      const error = new Error("offline");
      this.emit("error", error);
      return Promise.reject(error);
    };
  }

  downloaded(version: string): void {
    this.emit("update-downloaded", { version });
  }
}

function setUp(options: { busy?: () => boolean; restart?: boolean } = {}) {
  const source = new FakeSource();
  const asked: string[] = [];
  const told: string[] = [];
  let changes = 0;
  const updater = new Updater({
    source,
    currentVersion: "1.0.0",
    ask: (version) => {
      asked.push(version);
      return Promise.resolve(options.restart ?? false);
    },
    tell: (message) => told.push(message),
    isBusy: options.busy ?? (() => false),
    onChange: () => (changes += 1),
  });
  return { source, updater, asked, told, changes: () => changes };
}

/** Lets the promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("Updater (ADR-DESK-041)", () => {
  test("it downloads by itself and installs when the app quits", () => {
    const { source } = setUp();

    expect(source.autoDownload).toBe(true);
    expect(source.autoInstallOnAppQuit).toBe(true);
  });

  test("it looks after the first delay, then every interval, silently when up to date", async () => {
    vi.useFakeTimers();
    const { source, updater, told } = setUp();
    source.upToDate();
    updater.start();

    await vi.advanceTimersByTimeAsync(config.updateFirstCheckDelay - 1);
    expect(source.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(config.updateCheckInterval);
    expect(source.checks).toBe(2);
    expect(told).toEqual([]);
    expect(updater.state).toEqual({ kind: "idle" });

    updater.stop();
    await vi.advanceTimersByTimeAsync(config.updateCheckInterval);
    expect(source.checks).toBe(2);
  });

  test("a downloaded update is offered once; Later leaves it to install at the quit", async () => {
    const { source, updater, asked } = setUp({ restart: false });
    source.finds("1.1.0");

    updater.checkNow();
    await settle();
    expect(updater.state).toEqual({ kind: "downloading", version: "1.1.0" });
    expect(asked).toEqual([]);

    source.downloaded("1.1.0");
    await settle();
    expect(updater.state).toEqual({ kind: "ready", version: "1.1.0" });
    expect(asked).toEqual(["1.1.0"]);
    expect(source.installs).toBe(0);

    // Nothing asks again, and nothing newer is looked for until the quit installs it.
    updater.appIsFree();
    updater.checkNow();
    await settle();
    expect(asked).toEqual(["1.1.0"]);
    expect(source.checks).toBe(1);

    // The menu's Restart to Update.
    updater.restart();
    expect(source.installs).toBe(1);
  });

  test("Restart Now installs at once", async () => {
    const { source, asked } = setUp({ restart: true });

    source.downloaded("1.1.0");
    await settle();

    expect(asked).toEqual(["1.1.0"]);
    expect(source.installs).toBe(1);
  });

  test("the question waits while the user dictates or reads the chat", async () => {
    let busy = true;
    const { source, updater, asked } = setUp({ busy: () => busy });

    source.downloaded("1.1.0");
    updater.appIsFree();
    await settle();
    expect(asked).toEqual([]);

    busy = false;
    updater.appIsFree();
    updater.appIsFree();
    await settle();
    expect(asked).toEqual(["1.1.0"]);
  });

  test("Check for Updates says when the app is up to date, or couldn't look", async () => {
    const { source, updater, told } = setUp();

    source.upToDate();
    updater.checkNow();
    await settle();
    expect(told).toEqual(["TabMail Voice is up to date."]);

    source.fails();
    updater.checkNow();
    await settle();
    expect(told).toEqual(["TabMail Voice is up to date.", "Couldn't check for updates."]);
    expect(updater.state).toEqual({ kind: "idle" });
  });

  test("a failed background check says nothing, and the next one runs", async () => {
    vi.useFakeTimers();
    const { source, updater, told } = setUp();
    source.fails();
    updater.start();

    await vi.advanceTimersByTimeAsync(config.updateFirstCheckDelay);
    expect(told).toEqual([]);
    expect(updater.state).toEqual({ kind: "idle" });

    source.finds("1.1.0");
    await vi.advanceTimersByTimeAsync(config.updateCheckInterval);
    expect(source.checks).toBe(2);
    expect(updater.state).toEqual({ kind: "downloading", version: "1.1.0" });
    updater.stop();
  });

  test("one check at a time", async () => {
    const { source, updater } = setUp();
    let answer: (result: CheckResult) => void = () => {};
    source.answer = () => new Promise((resolve) => (answer = resolve));

    updater.checkNow();
    expect(updater.state).toEqual({ kind: "checking" });
    updater.checkNow();
    expect(source.checks).toBe(1);

    answer({ isUpdateAvailable: false });
    await settle();
    expect(updater.state).toEqual({ kind: "idle" });
  });

  test("an update macOS refuses to install is dropped, and Restart does nothing", async () => {
    const { source, updater } = setUp({ busy: () => true });

    source.downloaded("1.1.0");
    source.emit("error", new Error("Code signature did not pass validation"));
    updater.restart();

    expect(updater.state).toEqual({ kind: "idle" });
    expect(source.installs).toBe(0);
  });

  test("every change reaches the menu", async () => {
    const { source, updater, changes } = setUp();
    source.finds("1.1.0");

    updater.checkNow();
    await settle();
    source.downloaded("1.1.0");

    // checking, downloading, ready
    expect(changes()).toBe(3);
  });
});
