// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../core/config.js";
import { PasteTargetError } from "../../core/dictation/targetWindow.js";
import { errorName, log } from "../../core/log.js";
import { CancellationError } from "../../core/util/timeout.js";
import { type HelperClient } from "./helperClient.js";
import { type ScreenReader } from "./screenReader.js";

/** OS identity shared by a target's readers and paste. macOS's string is reader-instance scoped;
 * Linux additionally names the exact AT-SPI frame by its bus and object path. No user text. */
export interface NativeTargetWindow {
  window: number | string;
  pid: number;
  bus?: string;
  path?: string;
}

/** One operation's native target. The core carries only this instance's numeric handle. */
export class TargetWindows {
  private sequence = 0;
  private current: { handle: number; target: NativeTargetWindow } | null = null;

  constructor(private readonly system: HelperClient, private readonly reader: ScreenReader, private readonly platform: NodeJS.Platform) {}

  async capture(): Promise<number | null> {
    const handle = ++this.sequence;
    this.current = null;
    const target = await this.reader.captureTarget(this.platform === "darwin" ? undefined : this.system);
    if (handle !== this.sequence || target === null || !Number.isSafeInteger(target.pid) || target.pid <= 0 ||
        !(typeof target.window === "string" ? target.window.length > 0 : Number.isSafeInteger(target.window) && target.window > 0)) return null;
    this.current = { handle, target };
    return handle;
  }

  native(handle: number | null): NativeTargetWindow | null {
    return this.current?.handle === handle ? this.current.target : null;
  }

  /** The correction reader's identity, on the platforms where a process names its field. */
  appOf(handle: number): number | null { return this.native(handle)?.pid ?? null; }
  windowOf(handle: number): number | null {
    const window = this.native(handle)?.window;
    return typeof window === "number" ? window : null;
  }

  async paste(text: string, signal: AbortSignal, handle: number): Promise<void> {
    const target = this.native(handle);
    if (signal.aborted) throw new CancellationError();
    if (!target) throw new PasteTargetError();
    const deadline = Date.now() + config.helperRequestTimeout;
    if (this.platform !== "darwin") {
      try {
        await this.system.request("insert", { text, target, deadline }, config.helperRequestTimeout + config.insertionReplyGrace, signal);
      } catch (error) {
        if (signal.aborted) throw new CancellationError();
        log.debug(`TargetWindows: native paste refused: ${errorName(error)}`);
        throw new PasteTargetError();
      }
      return;
    }
    // Clipboard ownership stays in the system helper. The reader that retains the AX window does
    // the final check and posts the keys, without an IPC gap between those two operations.
    const { transaction } = await this.system.request<{ transaction: number }>("preparePaste", { text }, config.helperRequestTimeout, signal);
    try {
      if (signal.aborted) throw new CancellationError();
      await this.reader.pasteTarget(target, transaction, deadline, signal);
    } catch (error) {
      if (signal.aborted) throw new CancellationError();
      log.debug(`TargetWindows: target could not receive paste: ${errorName(error)}`);
      throw new PasteTargetError();
    } finally {
      // Cleanup has its own lifetime, including when the dictation was canceled. The native helper
      // checks this transaction before restoring, so a later copy or paste always wins.
      await this.system.request("finishPaste", { transaction }).catch((error: unknown) => {
        log.debug(`TargetWindows: clipboard finish failed: ${errorName(error)}`);
      });
    }
  }
}
