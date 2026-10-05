// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import type { OutgoingHttpHeaders } from "node:http";
import * as config from "../core/config.js";
import { errorName, log } from "../core/log.js";
import type { UpdateState } from "../core/ui/menuModel.js";
import type { KeyValueStore } from "../core/util/keyValueStore.js";

/** Sent with every update request in place of `electron-updater`'s own `x-user-staging-id`, a random
 * ID it keeps for the installation (for staged rollouts, which we don't use): nothing about the user
 * or the installation leaves the computer with an update check (ADR-DESK-041). Its headers are
 * merged over the library's. */
export const updateRequestHeaders = { "x-user-staging-id": "none" };

/** The store's key for the version an install was begun for, until the next launch says whether it
 * happened. */
export const installingKey = "updateInstalling";

/** One file of a release, as the feed lists it: its SHA-512 is base64. */
export interface UpdateFile {
  url: string;
  sha512: string;
}

/** What `electron-updater` says about the update it found and, once downloaded, where it is. The
 * Linux feed also carries `signature` (ADR-DESK-050). */
export interface UpdateInfo {
  version: string;
  files?: UpdateFile[];
  signature?: string;
  downloadedFile?: string;
}

/** `electron-updater`'s updater for this OS, as far as `Updater` uses it. */
export interface UpdateSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  requestHeaders: OutgoingHttpHeaders | null;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; downloadPromise?: Promise<unknown> | null } | null>;
  on(event: "update-available" | "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** An update refused or not installed, with what to tell the user. `canceled`: the user called the
 * install off (the administrator's authorization); nothing failed. `quiet`: not shown, as macOS
 * refusing an app run off its disk image (ADR-DESK-041). */
export class UpdateError extends Error {
  constructor(
    message: string,
    readonly options: { canceled?: boolean; quiet?: boolean } = {},
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

/** What differs per OS (`native/<os>/update.ts`, ADR-DESK-050): how a downloaded update is proven
 * ours, and how it is installed. Everything else (when to look, the download, the states, the
 * question, failures and retries) is `Updater`'s, the same everywhere. */
export interface UpdatePlatform {
  readonly source: UpdateSource;
  /** True where a verified update installs itself when the app quits (macOS, Windows); false where
   * it waits for the user to install it with an administrator's authorization (Linux). */
  readonly installsOnQuit: boolean;
  /** Resolves once the downloaded update is proven ours and to be `update.version`; rejects with an
   * `UpdateError` otherwise. */
  verify(update: UpdateInfo): Promise<void>;
  /** Installs the verified update and opens the new version: the app quits. Rejects with an
   * `UpdateError` when nothing was installed. */
  install(update: UpdateInfo): Promise<void>;
}

export interface UpdaterOptions {
  platform: UpdatePlatform;
  /** Keeps `installingKey` across the restart. */
  store: KeyValueStore;
  /** The running app's version, for "up to date" and "newer". */
  currentVersion: string;
  /** Asks whether to install `version` now (restarting where it installs at the quit); true to. */
  ask(version: string, installsOnQuit: boolean): Promise<boolean>;
  /** Answers "Check for Updates…", and says why an install the user asked for didn't happen. */
  tell(message: string, detail: string): void;
  /** Whether the user is dictating or has the chat window open: the question waits until not. */
  isBusy(): boolean;
  /** The state changed: the menu shows it. */
  onChange(): void;
}

/**
 * Keeps a packaged app up to date (ADR-DESK-041, ADR-DESK-050): looks for a newer release on
 * cdn.tabmail.ai at launch and every `updateCheckInterval`, downloads it quietly, has the platform
 * prove it ours and newer, and then installs it when the app quits (macOS, Windows) or when the user
 * installs it with an administrator's authorization (Linux). Once it is ready the user is asked once
 * whether to install now, never during a dictation or while the chat window is open, and the menu
 * offers it until then. A download, a proof or an install that fails is shown as failed until the
 * next check tries again; nothing is ever called installed that wasn't.
 */
export class Updater {
  private current: UpdateState = { kind: "idle" };
  /** The version the user was asked about: once per update, not per check. */
  private asked: string | null = null;
  /** The verified update, while ready. */
  private update: UpdateInfo | null = null;
  /** While the platform proves a download: its refusal, not the library's error, says why. */
  private verifying = false;

  constructor(private readonly options: UpdaterOptions) {
    const { source } = options.platform;
    source.autoDownload = true;
    // On while running: the library arms its quit-time install only when a download finishes with
    // this on. What actually installs at the quit is decided as the app quits (`quitting`).
    source.autoInstallOnAppQuit = options.platform.installsOnQuit;
    // Never install an older version, whatever a feed says (`channel` would turn this on).
    source.allowDowngrade = false;
    source.requestHeaders = { ...updateRequestHeaders };
    source.on("update-available", (info) => {
      log.debug(`Updater: downloading ${info.version}`);
      this.set({ kind: "downloading", version: info.version });
    });
    source.on("update-downloaded", (info) => void this.verify(info));
    // A failed check is the check's to report; a failed download (Windows: one not signed by us)
    // leaves nothing to install, until the next check tries again.
    source.on("error", (error) => {
      if (this.verifying) return;
      log.error(`Updater: ${describe(error)}`);
      const current = this.current;
      if (current.kind !== "downloading") return;
      this.fail(current.version, code(error) === "ERR_UPDATER_INVALID_SIGNATURE"
        ? `Version ${current.version} isn't signed by TabMail, so it wasn't installed.`
        : `Version ${current.version} couldn't be downloaded.`);
    });
    this.recallInstall();
  }

  get state(): UpdateState {
    return this.current;
  }

  /** Looks for an update after `updateFirstCheckDelay`, then every `updateCheckInterval`. */
  start(): void {
    setTimeout(() => void this.check(false), config.updateFirstCheckDelay);
    setInterval(() => void this.check(false), config.updateCheckInterval);
  }

  /** "Check for Updates…" (and "Try Again" after a failure): looks at once and says what it found. */
  checkNow(): void {
    void this.check(true);
  }

  /** "Restart to Update" / "Install Update…": installs the ready update now. */
  install(): void {
    void this.installNow();
  }

  /** The user stopped dictating or closed the chat window: a question that waited is asked now. */
  appIsFree(): void {
    this.offer();
  }

  /** The app is quitting (`before-quit`, ahead of the library's `quit`): only a proven update installs
   * now. What the library kept but this refused (not newer, not ours) or hasn't proven yet doesn't;
   * it keeps an installer it already had without the proof a download gets. */
  quitting(): void {
    if (this.options.platform.installsOnQuit) this.options.platform.source.autoInstallOnAppQuit = this.current.kind === "ready";
  }

  /** An install begun before this launch either happened (this is that version, or newer) or didn't:
   * then it is shown as failed, and the next check tries again. */
  private recallInstall(): void {
    const version = this.options.store.get(installingKey);
    if (typeof version !== "string") return;
    this.options.store.remove(installingKey);
    if (!isNewer(version, this.options.currentVersion)) {
      log.debug(`Updater: ${version} installed`);
      return;
    }
    log.error("Updater: the update begun before this launch didn't install");
    this.current = { kind: "failed", version, message: `Version ${version} didn't install.` };
  }

  private async check(userAsked: boolean): Promise<void> {
    // One at a time; a ready update waits for its install, so nothing newer is looked for.
    if (this.current.kind !== "idle" && this.current.kind !== "failed") return;
    this.set({ kind: "checking" });
    try {
      const result = await this.options.platform.source.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.set({ kind: "idle" });
        if (userAsked) this.options.tell("TabMail Voice is up to date.", `Version ${this.options.currentVersion} is the latest version.`);
        return;
      }
      // `update-available` came before the result, so the state says it downloads. A failed download
      // is reported as an `error` event, handled above.
      result.downloadPromise?.catch(() => undefined);
    } catch (error) {
      log.error(`Updater: check failed: ${describe(error)}`);
      this.set({ kind: "idle" });
      if (userAsked) this.options.tell("Couldn't check for updates.", "Check your internet connection and try again.");
    }
  }

  /** Has the platform prove the download ours; then it is ready, and the user is asked. */
  private async verify(info: UpdateInfo): Promise<void> {
    const { version } = info;
    log.debug(`Updater: downloaded ${version}`);
    // The library refuses an older feed too; the platform's proof binds the version to the file.
    if (!isNewer(version, this.options.currentVersion)) {
      this.fail(version, `Version ${version} isn't newer than this one.`);
      return;
    }
    this.verifying = true;
    try {
      await this.options.platform.verify(info);
    } catch (error) {
      log.error(`Updater: ${version} refused: ${reason(error)}`);
      if (error instanceof UpdateError && error.options.quiet) this.set({ kind: "idle" });
      else this.fail(version, error instanceof UpdateError ? error.message : `Version ${version} couldn't be checked.`);
      return;
    } finally {
      this.verifying = false;
    }
    log.debug(`Updater: ${version} is ready`);
    this.update = info;
    const { installsOnQuit } = this.options.platform;
    // Installs at the quit from now on: the next launch says whether it did.
    if (installsOnQuit) this.options.store.set(installingKey, version);
    this.set({ kind: "ready", version, installsOnQuit });
    this.offer();
  }

  private async installNow(): Promise<void> {
    const current = this.current;
    const update = this.update;
    if (current.kind !== "ready" || update === null) return;
    const { version } = current;
    this.options.store.set(installingKey, version);
    if (!current.installsOnQuit) this.set({ kind: "installing", version });
    try {
      await this.options.platform.install(update);
    } catch (error) {
      log.error(`Updater: ${version} not installed: ${reason(error)}`);
      if (!current.installsOnQuit) this.options.store.remove(installingKey);
      if (error instanceof UpdateError && error.options.canceled) {
        // Nothing failed: it stays ready, to install when the user is.
        this.set(current);
        this.options.tell(`TabMail Voice ${version} wasn't installed.`, error.message);
        return;
      }
      const message = error instanceof UpdateError ? error.message : `Version ${version} couldn't be installed.`;
      this.fail(version, message);
      this.options.tell(`TabMail Voice ${version} wasn't installed.`, message);
    }
  }

  /** Asks on a task of its own: the question is a modal dialog that holds the main process until
   * answered, so it never runs inside what led here (the dictation's phase change, the chat's
   * closing, the platform's event). */
  private offer(): void {
    setImmediate(() => {
      const current = this.current;
      if (current.kind !== "ready" || this.asked === current.version || this.options.isBusy()) return;
      this.asked = current.version;
      this.options.ask(current.version, current.installsOnQuit).then(
        (install) => {
          if (install) this.install();
        },
        (error: unknown) => {
          log.error(`Updater: couldn't ask to install: ${describe(error)}`);
        },
      );
    });
  }

  private fail(version: string, message: string): void {
    this.update = null;
    this.set({ kind: "failed", version, message });
  }

  private set(state: UpdateState): void {
    this.current = state;
    this.options.onChange();
  }
}

/** Whether `version` is a later x.y.z than `than`; anything not x.y.z is not (releases are x.y.z). */
export function isNewer(version: string, than: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number) ?? null;
  const a = parse(version);
  const b = parse(than);
  if (a === null || b === null) return false;
  const difference = a.map((part, index) => part - (b[index] ?? 0)).find((part) => part !== 0);
  return difference !== undefined && difference > 0;
}

function code(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

/** An error's type, and `electron-updater`'s code (`ERR_UPDATER_…`) where it gives one. */
function describe(error: unknown): string {
  const errorCode = code(error);
  return `${errorName(error)}${errorCode === null ? "" : ` ${errorCode}`}`;
}

/** Why a platform refused or didn't install an update: its own words (fixed sentences, never user
 * content), or else the error's type. */
function reason(error: unknown): string {
  return error instanceof UpdateError ? error.message : describe(error);
}

/** How an adapter runs a program: its exit code and output, whatever the code; it rejects only when
 * the program couldn't run or ran past `timeout` (ms, none when absent). */
export type RunFile = (file: string, args: string[], timeout?: number) => Promise<{ code: number; stdout: string }>;

export const runFile: RunFile = (file, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", windowsHide: true, timeout: timeout ?? 0, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolve({ code: 0, stdout });
      else if (typeof error.code === "number" && !error.killed) resolve({ code: error.code, stdout });
      else reject(error);
    });
  });
