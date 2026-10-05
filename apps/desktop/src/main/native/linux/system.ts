// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AudioCommand, AudioReport } from "../../../shared/ipc.js";
import * as config from "../../../core/config.js";
import type { ScreenExclusions } from "../../../core/dictation/excludedSites.js";
import type { ScreenRead } from "../../../core/dictation/screenContext.js";
import type { Rect } from "../../../core/ui/overlayGeometry.js";
import { HelperError, type HelperClient } from "../helperClient.js";
import { NativeMicrophone } from "../microphone.js";
import { keyboardLanguageCode } from "../keyboardLanguage.js";

/** Native Ubuntu device and focused-field operations, through voice-linux. */
export class LinuxSystem {
  constructor(private readonly helper: HelperClient, private readonly geometryHelper: HelperClient = helper) {}

  /** Inserts only into the original positive target; the native helper revalidates it. */
  async paste(text: string, signal: AbortSignal, window: number): Promise<void> {
    if (!Number.isSafeInteger(window) || window <= 0) throw new HelperError("failed", "insert", "invalid target");
    const reply = await this.helper.request<{ status?: unknown } | null>("insert", { text, window, restoreDelay: config.clipboardRestoreDelay, deadline: Date.now() + config.helperRequestTimeout }, config.helperRequestTimeout + config.clipboardRestoreDelay, signal);
    if (reply?.status === "clipboard-unavailable") {
      throw new Error("Couldn't paste. Your text is saved in history.");
    }
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

  /** Complete focused editable field for local correction learning; long/password fields refused. */
  async focusedFieldValue(window: number, exclusions: ScreenExclusions): Promise<string | null> {
    if (!Number.isSafeInteger(window) || window <= 0) return null;
    const reply = await this.helper.request<{ value?: unknown } | null>("focusedFieldValue", { window, maxLength: config.correctionMaxFieldLength, excludedAppIDs: exclusions.apps, excludedHosts: exclusions.sites });
    return typeof reply?.value === "string" && reply.value.length <= config.correctionMaxFieldLength ? reply.value : null;
  }

  readScreen(exclusions: ScreenExclusions): Promise<ScreenRead | null> {
    return this.helper.request("readScreen", { excludedAppIDs: exclusions.apps, excludedHosts: exclusions.sites }, config.screenReadTimeout);
  }

  /** The executable picked for screen-reading exclusion; never launches the app. */
  appInfo(path: string): Promise<{ bundleIdentifier: string; name: string; path: string } | null> {
    return this.helper.request("appInfo", { path });
  }

  /** The focused element's own caret, which the optional GNOME extension places on the screen
   * (logical coordinates); where the app reports none, the extension's input-method rectangle,
   * which some apps don't keep at the caret (LibreOffice gives the start of the sentence, a GTK 4
   * terminal the caret before its last output). Both are asked at once, before a screen read can
   * occupy the accessibility helper. */
  async caretAnchor(): Promise<Rect | null> {
    const accessible = this.helper.request<Rect | null>("caretAnchor", {}, config.linuxCaretRequestTimeout);
    const compositor = this.geometryHelper.request<Rect | null>("caretAnchor", {}, config.linuxCaretRequestTimeout);
    const caret = usable(await accessible.catch(() => null));
    if (caret) {
      void compositor.catch(() => undefined);
      return caret;
    }
    return usable(await compositor);
  }

  readonly microphone = (report: (report: AudioReport) => void): (command: AudioCommand) => void =>
    new NativeMicrophone(this.helper, "LinuxSystem").microphone(report);
}

function usable(rect: Rect | null): Rect | null {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}
