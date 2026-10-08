// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { screen } from "electron";
import * as config from "../../../core/config.js";
import type { Rect } from "../../../core/ui/overlayGeometry.js";
import { HelperError, type HelperClient } from "../helperClient.js";
import { keyboardLanguageCode } from "../keyboardLanguage.js";

/** Native Windows device and foreground-window operations, through voice-windows.exe. */
export class WindowsSystem {
  constructor(private readonly helper: HelperClient) {}

  /** Inserts only into the original positive target; the native helper revalidates it. */
  async paste(text: string, signal: AbortSignal, window: number): Promise<void> {
    if (!Number.isSafeInteger(window) || window <= 0) throw new HelperError("failed", "insert", "invalid target");
    await this.helper.request("insert", { text, window, deadline: Date.now() + config.helperRequestTimeout }, config.helperRequestTimeout + config.insertionReplyGrace, signal);
  }

  /** Opaque foreground window identity, rather than a process id shared by multiple windows. */
  async frontmostApp(): Promise<number | null> {
    const reply = await this.helper.request<{ window?: unknown } | null>("frontmostApp");
    return typeof reply?.window === "number" && Number.isSafeInteger(reply.window) && reply.window > 0 ? reply.window : null;
  }

  async keyboardLanguage(): Promise<string | null> {
    const reply = await this.helper.request<{ code?: unknown } | null>("keyboardLanguage");
    return keyboardLanguageCode(reply?.code);
  }

  async fullUserName(): Promise<string> {
    const reply = await this.helper.request<{ name?: unknown } | null>("fullUserName");
    if (typeof reply?.name !== "string") throw new HelperError("failed", "fullUserName", "no name in reply");
    return reply.name;
  }

  /** The executable picked for screen-reading exclusion; never launches the app. */
  appInfo(path: string): Promise<{ bundleIdentifier: string; name: string; path: string } | null> {
    return this.helper.request("appInfo", { path });
  }

  /** Visible Start/Search surfaces, in the same DIP coordinate space as overlay placement. */
  async shellExclusionBounds(): Promise<Rect[]> {
    const reply = await this.helper.request<unknown>("shellExclusionBounds");
    if (!Array.isArray(reply) || reply.length > 16) throw new HelperError("failed", "shellExclusionBounds", "invalid bounds");
    return reply.map((value: unknown) => {
      if (typeof value !== "object" || value === null) throw new HelperError("failed", "shellExclusionBounds", "invalid rectangle");
      const rect = value as Rect;
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
        throw new HelperError("failed", "shellExclusionBounds", "invalid rectangle");
      }
      return screen.screenToDipRect(null, rect);
    });
  }

  async caretAnchor(window?: number): Promise<Rect | null> {
    if (window !== undefined && (!Number.isSafeInteger(window) || window <= 0)) return null;
    const rect = await this.helper.request<Rect | null>("caretAnchor", window === undefined ? {} : { window });
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height <= 0) return null;
    return screen.screenToDipRect(null, rect);
  }
}
