// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../src/core/config.js";
import { type UpdateSource, Updater, updateRequestHeaders } from "../src/main/updater.js";

type CheckResult = Awaited<ReturnType<UpdateSource["checkForUpdates"]>>;

/** `electron-updater` as `Updater` sees it: a check runs `answer`, which emits what the real one
 * would (`update-available` before the result resolves). */
class FakeSource extends EventEmitter implements UpdateSource {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  requestHeaders: Record<string, string> | null = null;
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

  /** The next check finds `version`, whose download fails as the real one reports it: an `error`
   * event and a rejected `downloadPromise`. */
  findsButCantDownload(version: string): void {
    this.answer = () => {
      this.emit("update-available", { version });
      const error = new Error("download failed");
      const downloadPromise = new Promise((_resolve, reject) => setImmediate(() => {
        this.emit("error", error);
        reject(error);
      }));
      return Promise.resolve({ isUpdateAvailable: true, downloadPromise });
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

  /** `electron-updater` has downloaded `version`, and macOS then accepts it. */
  downloaded(version: string): void {
    this.emit("update-downloaded", { version });
    this.installer.emit("update-downloaded");
  }

  /** `electron-updater` has downloaded `version`; macOS then fetches it on a later task, as the real
   * one does, and refuses it (a signature that isn't ours, an app run off its disk image). */
  downloadedButRefused(version: string): Promise<void> {
    this.emit("update-downloaded", { version });
    return new Promise((resolve) => setTimeout(() => {
      this.emit("error", new Error("Code signature did not pass validation"));
      resolve();
    }, 0));
  }

  /** Squirrel.Mac, Electron's own `autoUpdater`. */
  readonly installer = new EventEmitter();
}

function setUp(options: { busy?: () => boolean; restart?: boolean; ask?: (version: string) => Promise<boolean> } = {}) {
  const source = new FakeSource();
  const asked: string[] = [];
  const told: string[] = [];
  let changes = 0;
  const updater = new Updater({
    source,
    installer: source.installer,
    currentVersion: "1.0.0",
    ask: (version) => {
      asked.push(version);
      return options.ask ? options.ask(version) : Promise.resolve(options.restart ?? false);
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
  vi.clearAllTimers();
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

  /** The question is a modal dialog that holds the main process: it must never run inside the
   * dictation's phase change or the chat's closing (`appIsFree`), nor inside `electron-updater`'s
   * event, only after they return. */
  test("the question is asked after what freed the app, or finished the download, has returned", async () => {
    let busy = false;
    const { source, updater, asked } = setUp({ busy: () => busy });

    source.downloaded("1.1.0");
    expect(asked).toEqual([]);
    await settle();
    expect(asked).toEqual(["1.1.0"]);

    busy = true;
    source.downloaded("1.2.0");
    await settle();
    busy = false;
    updater.appIsFree();
    expect(asked).toEqual(["1.1.0"]);
    await settle();
    expect(asked).toEqual(["1.1.0", "1.2.0"]);
  });

  test("an update macOS refuses is never asked about, and Restart does nothing", async () => {
    const { source, updater, asked } = setUp({ restart: true });
    source.finds("1.1.0");
    updater.checkNow();
    await settle();

    await source.downloadedButRefused("1.1.0");
    await settle();
    updater.restart();

    expect(asked).toEqual([]);
    expect(updater.state).toEqual({ kind: "idle" });
    expect(source.installs).toBe(0);
  });

  test("the update is ready only once macOS has accepted it", async () => {
    const { source, updater, asked } = setUp();
    source.finds("1.1.0");
    updater.checkNow();
    await settle();

    source.emit("update-downloaded", { version: "1.1.0" });
    await settle();
    updater.restart();
    expect(updater.state).toEqual({ kind: "downloading", version: "1.1.0" });
    expect(asked).toEqual([]);
    expect(source.installs).toBe(0);

    source.installer.emit("update-downloaded");
    await settle();
    expect(updater.state).toEqual({ kind: "ready", version: "1.1.0" });
    expect(asked).toEqual(["1.1.0"]);
  });

  test("macOS saying it has an update no download led to changes nothing", async () => {
    const { source, updater, asked } = setUp();

    source.installer.emit("update-downloaded");
    await source.downloadedButRefused("1.1.0");
    source.installer.emit("update-downloaded");
    await settle();

    expect(updater.state).toEqual({ kind: "idle" });
    expect(asked).toEqual([]);
  });

  test("a failed download leaves nothing unhandled, and the next check starts over", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const { source, updater } = setUp();
      source.findsButCantDownload("1.1.0");

      updater.checkNow();
      await settle();
      await settle();
      expect(updater.state).toEqual({ kind: "idle" });

      source.finds("1.1.0");
      updater.checkNow();
      await settle();
      expect(updater.state).toEqual({ kind: "downloading", version: "1.1.0" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("a question that couldn't be shown doesn't stop the next update's", async () => {
    const { source, asked } = setUp({ ask: (version) => (version === "1.1.0" ? Promise.reject(new Error("no dialog")) : Promise.resolve(false)) });

    source.downloaded("1.1.0");
    await settle();
    source.emit("error", new Error("Code signature did not pass validation"));
    source.downloaded("1.2.0");
    await settle();

    expect(asked).toEqual(["1.1.0", "1.2.0"]);
  });

  /** Nothing about the user or the installation leaves the computer with an update check: the real
   * `electron-updater` merges the updater's headers over its own, so the random installation ID it
   * keeps for staged rollouts is never sent, with the feed request or the download. */
  test("an update request carries no installation ID", async () => {
    // Its constructor and header merging are internal: reached through a cast, as the app never does.
    const { AppUpdater } = (await import("electron-updater/out/AppUpdater.js")) as unknown as {
      AppUpdater: new (options: null, app: object) => UpdateSource & {
        computeFinalHeaders(headers: Record<string, string>): Record<string, string>;
        computeRequestHeaders(provider: { fileExtraDownloadHeaders: null }): Record<string, string>;
      };
    };
    const real = new AppUpdater(null, { version: "1.0.0", name: "TabMail Voice", isPackaged: true, appUpdateConfigPath: "/nonexistent", userDataPath: "/nonexistent", baseCachePath: "/nonexistent", whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {} });
    const installationID = "0b6f3c1e-1111-4222-8333-944445555666";
    expect(real.computeFinalHeaders({ "x-user-staging-id": installationID })["x-user-staging-id"]).toBe(installationID);

    new Updater({ source: real, installer: new EventEmitter(), currentVersion: "1.0.0", ask: () => Promise.resolve(false), tell: () => {}, isBusy: () => false, onChange: () => {} });

    const feedRequest = real.computeFinalHeaders({ "x-user-staging-id": installationID });
    const download = real.computeRequestHeaders({ fileExtraDownloadHeaders: null });
    for (const headers of [feedRequest, download]) {
      expect(JSON.stringify(headers)).not.toContain(installationID);
      expect(headers["x-user-staging-id"]).toBe(updateRequestHeaders["x-user-staging-id"]);
    }
  });
});
