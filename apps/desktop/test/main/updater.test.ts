// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as config from "../../src/core/config.js";
import { log } from "../../src/core/log.js";
import { MemoryStore } from "../../src/core/util/keyValueStore.js";
import { type MacUpdateSource, macUpdatePlatform } from "../../src/main/native/macos/update.js";
import { installingKey, isNewer, runFile, type UpdateInfo, type UpdatePlatform, type UpdateSource, Updater, UpdateError, updateRequestHeaders } from "../../src/main/updater.js";

type CheckResult = Awaited<ReturnType<UpdateSource["checkForUpdates"]>>;

/** `electron-updater` as `Updater` sees it: a check runs `answer`, which emits what the real one
 * would (`update-available` before the result resolves). */
class FakeSource extends EventEmitter implements UpdateSource {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
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

function setUp(options: { busy?: () => boolean; restart?: boolean; ask?: (version: string) => Promise<boolean>; store?: MemoryStore; currentVersion?: string } = {}) {
  const source = new FakeSource();
  const asked: string[] = [];
  const told: string[] = [];
  const store = options.store ?? new MemoryStore();
  let changes = 0;
  const updater = new Updater({
    platform: macUpdatePlatform({ source, installer: source.installer }),
    store,
    currentVersion: options.currentVersion ?? "1.0.0",
    ask: (version) => {
      asked.push(version);
      return options.ask ? options.ask(version) : Promise.resolve(options.restart ?? false);
    },
    tell: (message) => told.push(message),
    isBusy: options.busy ?? (() => false),
    onChange: () => (changes += 1),
  });
  return { source, updater, asked, told, store, changes: () => changes };
}

/** Lets the promise callbacks run, and then what they scheduled (the question, asked on a task of its
 * own after the proof). */
const settle = async () => {
  for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Updater on macOS (ADR-DESK-041)", () => {
  test("it downloads by itself, installs when the app quits, and never an older version", () => {
    const { source } = setUp();

    expect(source.autoDownload).toBe(true);
    expect(source.autoInstallOnAppQuit).toBe(true);
    expect(source.allowDowngrade).toBe(false);
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
    expect(updater.state).toEqual({ kind: "ready", version: "1.1.0", installsOnQuit: true });
    expect(asked).toEqual(["1.1.0"]);
    expect(source.installs).toBe(0);

    // Nothing asks again, and nothing newer is looked for until the quit installs it.
    updater.appIsFree();
    updater.checkNow();
    await settle();
    expect(asked).toEqual(["1.1.0"]);
    expect(source.checks).toBe(1);

    // The menu's Restart to Update.
    updater.install();
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

  test("an error after macOS accepted the update leaves it ready", async () => {
    const { source, updater } = setUp({ busy: () => true });

    source.downloaded("1.1.0");
    await settle();
    source.emit("error", new Error("Code signature did not pass validation"));
    updater.install();

    expect(updater.state).toEqual({ kind: "ready", version: "1.1.0", installsOnQuit: true });
    expect(source.installs).toBe(1);
  });

  test("every change reaches the menu", async () => {
    const { source, updater, changes } = setUp();
    source.finds("1.1.0");

    updater.checkNow();
    await settle();
    source.downloaded("1.1.0");
    await settle();

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
    updater.install();

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
    updater.install();
    expect(updater.state).toEqual({ kind: "downloading", version: "1.1.0" });
    expect(asked).toEqual([]);
    expect(source.installs).toBe(0);

    source.installer.emit("update-downloaded");
    await settle();
    expect(updater.state).toEqual({ kind: "ready", version: "1.1.0", installsOnQuit: true });
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

  test("a failed download shows as failed, leaves nothing unhandled, and the next check starts over", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const { source, updater } = setUp();
      source.findsButCantDownload("1.1.0");

      updater.checkNow();
      await settle();
      await settle();
      expect(updater.state).toEqual({ kind: "failed", version: "1.1.0", message: "Version 1.1.0 couldn't be downloaded." });

      source.finds("1.1.0");
      updater.checkNow();
      await settle();
      expect(updater.state).toEqual({ kind: "downloading", version: "1.1.0" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  /** The question stays open until answered; whatever frees the app meanwhile doesn't ask again. */
  test("an open question is not asked again", async () => {
    let busy = false;
    const { source, updater, asked } = setUp({ busy: () => busy, ask: () => new Promise(() => {}) });

    source.downloaded("1.1.0");
    await settle();
    busy = true;
    updater.appIsFree();
    busy = false;
    updater.appIsFree();
    await settle();

    expect(asked).toEqual(["1.1.0"]);
  });

  test("a failure is logged with its type and electron-updater's code", () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const { source } = setUp();
      source.emit("error", Object.assign(new Error("no zip"), { code: "ERR_UPDATER_ZIP_FILE_NOT_FOUND" }));
      source.emit("error", new TypeError("no code"));

      expect(logged.mock.calls).toEqual([["Updater: Error ERR_UPDATER_ZIP_FILE_NOT_FOUND"], ["Updater: TypeError"]]);
    } finally {
      logged.mockRestore();
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

    new Updater({ platform: macUpdatePlatform({ source: real as unknown as MacUpdateSource, installer: new EventEmitter() }), store: new MemoryStore(), currentVersion: "1.0.0", ask: () => Promise.resolve(false), tell: () => {}, isBusy: () => false, onChange: () => {} });

    const feedRequest = real.computeFinalHeaders({ "x-user-staging-id": installationID });
    const download = real.computeRequestHeaders({ fileExtraDownloadHeaders: null });
    for (const headers of [feedRequest, download]) {
      expect(JSON.stringify(headers)).not.toContain(installationID);
      expect(headers["x-user-staging-id"]).toBe(updateRequestHeaders["x-user-staging-id"]);
    }
  });
});

/** A platform whose proof and install the test settles: the shared lifecycle, as on Windows (installs
 * at the quit) and Linux (installs with an administrator's authorization). */
class FakePlatform implements UpdatePlatform {
  readonly source = new FakeSource();
  verified: UpdateInfo[] = [];
  installed: UpdateInfo[] = [];
  proof: () => Promise<void> = () => Promise.resolve();
  outcome: () => Promise<void> = () => Promise.resolve();

  constructor(readonly installsOnQuit: boolean) {}

  verify(update: UpdateInfo): Promise<void> {
    this.verified.push(update);
    return this.proof();
  }

  install(update: UpdateInfo): Promise<void> {
    this.installed.push(update);
    return this.outcome();
  }

  /** The library found and downloaded `version`. */
  downloads(version: string): void {
    this.source.emit("update-available", { version });
    this.source.emit("update-downloaded", { version, downloadedFile: `/cache/${version}` });
  }
}

function setUpOn(installsOnQuit: boolean, options: { store?: MemoryStore; currentVersion?: string; install?: boolean } = {}) {
  const platform = new FakePlatform(installsOnQuit);
  const store = options.store ?? new MemoryStore();
  const asked: [string, boolean][] = [];
  const told: [string, string][] = [];
  const updater = new Updater({
    platform,
    store,
    currentVersion: options.currentVersion ?? "1.0.0",
    ask: (version, onQuit) => {
      asked.push([version, onQuit]);
      return Promise.resolve(options.install ?? false);
    },
    tell: (message, detail) => told.push([message, detail]),
    isBusy: () => false,
    onChange: () => {},
  });
  return { platform, updater, store, asked, told };
}

describe("Updater, on every platform (ADR-DESK-050)", () => {
  test("where installing needs an administrator, nothing installs at the quit, and the user is asked to install", async () => {
    const { platform, updater, asked } = setUpOn(false);

    expect(platform.source.autoInstallOnAppQuit).toBe(false);
    expect(platform.source.allowDowngrade).toBe(false);
    platform.downloads("1.1.0");
    await settle();

    expect(updater.state).toEqual({ kind: "ready", version: "1.1.0", installsOnQuit: false });
    expect(asked).toEqual([["1.1.0", false]]);
    expect(platform.installed).toEqual([]);
  });

  test("an update the platform refuses is shown as failed, never offered, and can't be installed; the log says why", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const { platform, updater, asked } = setUpOn(true);
      platform.proof = () => Promise.reject(new UpdateError("It isn't signed by TabMail, so it wasn't installed."));

      platform.downloads("1.1.0");
      await settle();
      updater.install();
      await settle();

      expect(updater.state).toEqual({ kind: "failed", version: "1.1.0", message: "It isn't signed by TabMail, so it wasn't installed." });
      expect(asked).toEqual([]);
      expect(platform.installed).toEqual([]);
      expect(logged.mock.calls).toEqual([["Updater: 1.1.0 refused: It isn't signed by TabMail, so it wasn't installed."]]);
    } finally {
      logged.mockRestore();
    }
  });

  test("a proof that fails unexpectedly is a failure too, in words, and logged by its type only", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const { platform, updater } = setUpOn(true);
      platform.proof = () => Promise.reject(new TypeError("boom"));

      platform.downloads("1.1.0");
      await settle();

      expect(updater.state).toEqual({ kind: "failed", version: "1.1.0", message: "Version 1.1.0 couldn't be checked." });
      expect(logged.mock.calls).toEqual([["Updater: 1.1.0 refused: TypeError"]]);
    } finally {
      logged.mockRestore();
    }
  });

  test("a quiet refusal (macOS, an app off its disk image) shows nothing", async () => {
    const { platform, updater } = setUpOn(true);
    platform.proof = () => Promise.reject(new UpdateError("macOS refused the update.", { quiet: true }));

    platform.downloads("1.1.0");
    await settle();

    expect(updater.state).toEqual({ kind: "idle" });
  });

  /** The library refuses an older feed; a download that isn't newer is never even proven. */
  test.each(["1.0.0", "0.9.9", "1.1.0-beta", "1.1"])("a download of %s is refused unproven", async (version) => {
    const { platform, updater } = setUpOn(true);

    platform.downloads(version);
    await settle();

    expect(platform.verified).toEqual([]);
    expect(updater.state).toEqual({ kind: "failed", version, message: `Version ${version} isn't newer than this one.` });
  });

  test("Windows refusing the installer's signature in the download is shown as unsigned", async () => {
    const { platform, updater } = setUpOn(true);
    platform.source.finds("1.1.0");
    updater.checkNow();
    await settle();

    platform.source.emit("error", Object.assign(new Error("not signed"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }));

    expect(updater.state).toEqual({ kind: "failed", version: "1.1.0", message: "Version 1.1.0 isn't signed by TabMail, so it wasn't installed." });
  });

  test("the library's errors while the platform proves a download are the proof's to report", async () => {
    const { platform, updater } = setUpOn(true);
    let refuse: (error: Error) => void = () => {};
    platform.proof = () => new Promise((_resolve, reject) => (refuse = reject));

    platform.downloads("1.1.0");
    platform.source.emit("error", new Error("library"));
    expect(updater.state).toEqual({ kind: "downloading", version: "1.1.0" });
    refuse(new UpdateError("refused"));
    await settle();

    expect(updater.state).toEqual({ kind: "failed", version: "1.1.0", message: "refused" });
  });

  test("a failed update is tried again by the next check, and by Retry", async () => {
    vi.useFakeTimers();
    const { platform, updater } = setUpOn(true);
    platform.proof = () => Promise.reject(new UpdateError("refused"));
    platform.source.finds("1.1.0");
    updater.start();
    await vi.advanceTimersByTimeAsync(config.updateFirstCheckDelay);
    platform.source.emit("update-downloaded", { version: "1.1.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.state.kind).toBe("failed");

    await vi.advanceTimersByTimeAsync(config.updateCheckInterval);
    expect(platform.source.checks).toBe(2);
    platform.source.emit("update-downloaded", { version: "1.1.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.state.kind).toBe("failed");

    updater.checkNow();
    expect(platform.source.checks).toBe(3);
  });

  describe("the install", () => {
    test("where it installs at the quit, a ready update is recorded, and the next launch says whether it installed", async () => {
      const store = new MemoryStore();
      const { platform } = setUpOn(true, { store });
      platform.downloads("1.1.0");
      await settle();
      expect(store.get(installingKey)).toBe("1.1.0");

      // The app quit and came back as the old version: it didn't install.
      const failed = setUpOn(true, { store });
      expect(failed.updater.state).toEqual({ kind: "failed", version: "1.1.0", message: "Version 1.1.0 didn't install." });
      expect(store.get(installingKey)).toBeUndefined();

      store.set(installingKey, "1.1.0");
      const installed = setUpOn(true, { store, currentVersion: "1.1.0" });
      expect(installed.updater.state).toEqual({ kind: "idle" });
      expect(store.get(installingKey)).toBeUndefined();
    });

    test("with an administrator's authorization: installing, then the platform opens the new version", async () => {
      const store = new MemoryStore();
      const { platform, updater, told } = setUpOn(false, { store });
      let finish: () => void = () => {};
      platform.outcome = () => new Promise((resolve) => (finish = resolve));
      platform.downloads("1.1.0");
      await settle();
      expect(store.get(installingKey)).toBeUndefined();

      updater.install();
      expect(updater.state).toEqual({ kind: "installing", version: "1.1.0" });
      expect(store.get(installingKey)).toBe("1.1.0");
      expect(platform.installed).toEqual([expect.objectContaining({ version: "1.1.0", downloadedFile: "/cache/1.1.0" })]);
      // A second click while it installs does nothing.
      updater.install();
      expect(platform.installed).toHaveLength(1);

      finish();
      await settle();
      expect(told).toEqual([]);
    });

    test("an authorization the user dismissed installs nothing and leaves it ready, to install later", async () => {
      const store = new MemoryStore();
      const { platform, updater, told } = setUpOn(false, { store });
      platform.outcome = () => Promise.reject(new UpdateError("Installing needs an administrator's authorization.", { canceled: true }));
      platform.downloads("1.1.0");
      await settle();

      updater.install();
      await settle();

      expect(updater.state).toEqual({ kind: "ready", version: "1.1.0", installsOnQuit: false });
      expect(store.get(installingKey)).toBeUndefined();
      expect(told).toEqual([["TabMail Voice 1.1.0 wasn't installed.", "Installing needs an administrator's authorization."]]);
      updater.install();
      expect(platform.installed).toHaveLength(2);
    });

    test.each([
      [new UpdateError("The package manager couldn't install it."), "The package manager couldn't install it.", "The package manager couldn't install it."],
      [new TypeError("boom"), "Version 1.1.0 couldn't be installed.", "TypeError"],
    ])("an install that fails (%s) is shown as failed and said, never as installed", async (error, message, logLine) => {
      const logged = vi.spyOn(log, "error").mockImplementation(() => {});
      onTestFinished(() => logged.mockRestore());
      const store = new MemoryStore();
      const { platform, updater, told } = setUpOn(false, { store });
      platform.outcome = () => Promise.reject(error);
      platform.downloads("1.1.0");
      await settle();

      updater.install();
      await settle();

      expect(updater.state).toEqual({ kind: "failed", version: "1.1.0", message });
      expect(store.get(installingKey)).toBeUndefined();
      expect(told).toEqual([["TabMail Voice 1.1.0 wasn't installed.", message]]);
      expect(logged.mock.calls).toEqual([[`Updater: 1.1.0 not installed: ${logLine}`]]);
      updater.install();
      expect(platform.installed).toHaveLength(1);
    });

    test("nothing installs before an update is ready", () => {
      const { platform, updater } = setUpOn(false);

      updater.install();

      expect(platform.installed).toEqual([]);
    });
  });

  test.each<[string, string, boolean]>([
    ["1.0.1", "1.0.0", true],
    ["1.1.0", "1.0.9", true],
    ["2.0.0", "1.9.9", true],
    ["1.10.0", "1.9.0", true],
    ["1.0.0", "1.0.0", false],
    ["1.0.0", "1.0.1", false],
    ["0.9.9", "1.0.0", false],
    ["1.0.1-beta", "1.0.0", false],
    ["1.0.1", "garbage", false],
    ["v1.0.1", "1.0.0", false],
  ])("%s is newer than %s: %s", (version, than, newer) => {
    expect(isNewer(version, than)).toBe(newer);
  });
});

/** The installers' answers are exit codes (Linux `install-update` 3–6, pkexec 126/127): a code the
 * program chose comes back as its code, never as success or as a failure to run. Node stands in for
 * the programs, so this runs on every platform. */
describe("runFile", () => {
  const node = (script: string) => ["-e", script];

  test("returns the code the program exited with, and its output", async () => {
    await expect(runFile(process.execPath, node("process.stdout.write('ok')"))).resolves.toEqual({ code: 0, stdout: "ok" });
    await expect(runFile(process.execPath, node("process.stdout.write('refused'); process.exit(3)"))).resolves.toEqual({ code: 3, stdout: "refused" });
    await expect(runFile(process.execPath, node("process.exit(126)"))).resolves.toEqual({ code: 126, stdout: "" });
  });

  test("a program that runs past its time is stopped and fails", async () => {
    const started = Date.now();

    await expect(runFile(process.execPath, node("setTimeout(() => {}, 60000)"), 300)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("a program that can't run fails", async () => {
    await expect(runFile("/nonexistent/install-update", [])).rejects.toThrow();
  });
});
