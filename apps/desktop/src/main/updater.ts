// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../core/config.js";
import { errorName, log } from "../core/log.js";
import type { UpdateState } from "../core/menuModel.js";

/** `electron-updater`'s `autoUpdater`, as far as `Updater` uses it. */
export interface UpdateSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; downloadPromise?: Promise<unknown> | null } | null>;
  quitAndInstall(): void;
  on(event: "update-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface UpdaterOptions {
  source: UpdateSource;
  /** The running app's version, for "up to date". */
  currentVersion: string;
  /** Asks whether to restart now into `version`; true to restart. */
  ask(version: string): Promise<boolean>;
  /** Answers "Check for Updates…". */
  tell(message: string, detail: string): void;
  /** Whether the user is dictating or has the chat window open: the question waits until not. */
  isBusy(): boolean;
  /** The state changed: the menu shows it. */
  onChange(): void;
}

/**
 * Keeps a packaged app up to date (ADR-DESK-041): looks for a newer release on GitHub at launch and
 * every `updateCheckInterval`, downloads it quietly, and installs it when the app quits. Once it is
 * downloaded the user is asked once whether to restart now, never during a dictation or while the
 * chat window is open, and the menu offers the restart until then. macOS installs the update only if
 * it carries the same Developer ID signature as the running app (Squirrel.Mac).
 */
export class Updater {
  private current: UpdateState = { kind: "idle" };
  /** The version the user was asked about: once per update, not per check. */
  private asked: string | null = null;
  private asking = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly options: UpdaterOptions) {
    const { source } = options;
    source.autoDownload = true;
    source.autoInstallOnAppQuit = true;
    source.on("update-available", (info) => {
      log.debug(`Updater: downloading ${info.version}`);
      this.set({ kind: "downloading", version: info.version });
    });
    source.on("update-downloaded", (info) => {
      log.debug(`Updater: ${info.version} is ready`);
      this.set({ kind: "ready", version: info.version });
      this.offer();
    });
    // A failed check or download, or Squirrel.Mac refusing the update (a signature that isn't
    // ours): nothing to install, so the next check starts over.
    source.on("error", (error) => {
      log.error(`Updater: ${errorName(error)}`);
      this.set({ kind: "idle" });
    });
  }

  get state(): UpdateState {
    return this.current;
  }

  /** Looks for an update after `updateFirstCheckDelay`, then every `updateCheckInterval`. */
  start(): void {
    this.timers.push(
      setTimeout(() => void this.check(false), config.updateFirstCheckDelay),
      setInterval(() => void this.check(false), config.updateCheckInterval),
    );
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** "Check for Updates…": looks at once and says what it found. */
  checkNow(): void {
    void this.check(true);
  }

  /** "Restart to Update": quits, installs and opens the new version. */
  restart(): void {
    if (this.current.kind === "ready") this.options.source.quitAndInstall();
  }

  /** The user stopped dictating or closed the chat window: a question that waited is asked now. */
  appIsFree(): void {
    this.offer();
  }

  private async check(userAsked: boolean): Promise<void> {
    // One at a time; a downloaded update waits for the quit, so nothing newer is looked for.
    if (this.current.kind !== "idle") return;
    this.set({ kind: "checking" });
    try {
      const result = await this.options.source.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.set({ kind: "idle" });
        if (userAsked) this.options.tell("TabMail Voice is up to date.", `Version ${this.options.currentVersion} is the latest version.`);
        return;
      }
      // `update-available` came before the result, so the state says it downloads. A failed download
      // is reported as an `error` event, handled above.
      result.downloadPromise?.catch(() => undefined);
    } catch (error) {
      log.error(`Updater: check failed: ${errorName(error)}`);
      this.set({ kind: "idle" });
      if (userAsked) this.options.tell("Couldn't check for updates.", "Check your internet connection and try again.");
    }
  }

  private offer(): void {
    const current = this.current;
    if (current.kind !== "ready" || this.asking || this.asked === current.version || this.options.isBusy()) return;
    this.asked = current.version;
    this.asking = true;
    this.options.ask(current.version).then(
      (restart) => {
        this.asking = false;
        if (restart) this.restart();
      },
      (error: unknown) => {
        this.asking = false;
        log.error(`Updater: couldn't ask to restart: ${errorName(error)}`);
      },
    );
  }

  private set(state: UpdateState): void {
    this.current = state;
    this.options.onChange();
  }
}
