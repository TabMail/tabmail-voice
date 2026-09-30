// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { OutgoingHttpHeaders } from "node:http";
import * as config from "../core/config.js";
import { errorName, log } from "../core/log.js";
import type { UpdateState } from "../core/menuModel.js";

/** Sent with every update request in place of `electron-updater`'s own `x-user-staging-id`, a random
 * ID it keeps for the installation (for staged rollouts, which we don't use): nothing about the user
 * or the installation leaves the computer with an update check (ADR-DESK-041). Its headers are
 * merged over the library's. */
export const updateRequestHeaders = { "x-user-staging-id": "none" };

/** `electron-updater`'s `autoUpdater`, as far as `Updater` uses it. */
export interface UpdateSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  requestHeaders: OutgoingHttpHeaders | null;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; downloadPromise?: Promise<unknown> | null } | null>;
  quitAndInstall(): void;
  on(event: "update-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Electron's own `autoUpdater` (Squirrel.Mac), which installs what `electron-updater` downloaded. It
 * fetches the update from `electron-updater` only after `electron-updater` says `update-downloaded`,
 * checks that it carries the running app's Developer ID signature, and then says `update-downloaded`
 * itself; a refusal reaches `UpdateSource` as `error`. */
export interface Installer {
  on(event: "update-downloaded", listener: () => void): unknown;
}

export interface UpdaterOptions {
  source: UpdateSource;
  installer: Installer;
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
 * Keeps a packaged app up to date (ADR-DESK-041): looks for a newer release on cdn.tabmail.ai at launch and
 * every `updateCheckInterval`, downloads it quietly, and installs it when the app quits. Once it is
 * downloaded the user is asked once whether to restart now, never during a dictation or while the
 * chat window is open, and the menu offers the restart until then. An update is ready only once macOS
 * has accepted it (Squirrel.Mac: the same Developer ID signature as the running app); one it refuses,
 * as from an app run off its disk image, is never offered.
 */
export class Updater {
  private current: UpdateState = { kind: "idle" };
  /** The version the user was asked about: once per update, not per check. */
  private asked: string | null = null;
  /** The version `electron-updater` downloaded, while macOS fetches and checks it. */
  private downloaded: string | null = null;

  constructor(private readonly options: UpdaterOptions) {
    const { source, installer } = options;
    source.autoDownload = true;
    source.autoInstallOnAppQuit = true;
    source.requestHeaders = { ...updateRequestHeaders };
    source.on("update-available", (info) => {
      log.debug(`Updater: downloading ${info.version}`);
      this.set({ kind: "downloading", version: info.version });
    });
    // Not ready yet: macOS hasn't fetched or checked it, and may refuse it.
    source.on("update-downloaded", (info) => {
      log.debug(`Updater: downloaded ${info.version}`);
      this.downloaded = info.version;
    });
    installer.on("update-downloaded", () => {
      const version = this.downloaded;
      if (version === null) return;
      this.downloaded = null;
      log.debug(`Updater: ${version} is ready`);
      this.set({ kind: "ready", version });
      this.offer();
    });
    // A failed check or download, or Squirrel.Mac refusing the update (a signature that isn't
    // ours, an app run off its disk image): nothing to install, so the next check starts over.
    source.on("error", (error) => {
      log.error(`Updater: ${describe(error)}`);
      this.downloaded = null;
      this.set({ kind: "idle" });
    });
  }

  get state(): UpdateState {
    return this.current;
  }

  /** Looks for an update after `updateFirstCheckDelay`, then every `updateCheckInterval`. */
  start(): void {
    setTimeout(() => void this.check(false), config.updateFirstCheckDelay);
    setInterval(() => void this.check(false), config.updateCheckInterval);
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
      log.error(`Updater: check failed: ${describe(error)}`);
      this.set({ kind: "idle" });
      if (userAsked) this.options.tell("Couldn't check for updates.", "Check your internet connection and try again.");
    }
  }

  /** Asks on a task of its own: the question is a modal dialog that holds the main process until
   * answered, so it never runs inside what led here (the dictation's phase change, the chat's
   * closing, Squirrel.Mac's event). */
  private offer(): void {
    setImmediate(() => {
      const current = this.current;
      if (current.kind !== "ready" || this.asked === current.version || this.options.isBusy()) return;
      this.asked = current.version;
      this.options.ask(current.version).then(
        (restart) => {
          if (restart) this.restart();
        },
        (error: unknown) => {
          log.error(`Updater: couldn't ask to restart: ${describe(error)}`);
        },
      );
    });
  }

  private set(state: UpdateState): void {
    this.current = state;
    this.options.onChange();
  }
}

/** An error's type, and `electron-updater`'s code (`ERR_UPDATER_…`) where it gives one. */
function describe(error: unknown): string {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` ${error.code}` : "";
  return `${errorName(error)}${code}`;
}
