// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { FocusedElement, ThunderbirdSystem } from "../core/agent/thunderbirdRelay.js";
import * as config from "../core/config.js";
import type { GlobeKeySystem } from "../core/globeKeyAction.js";
import type { Rect } from "../core/overlayGeometry.js";
import type { ScreenContext } from "../core/screenContext.js";
import type { HelperClient } from "./helperClient.js";

/** What `voice-macos` does for the app (`MacService` in the helper), typed. */
export class MacSystem {
  constructor(private readonly helper: HelperClient) {}

  /** Pastes `text` into the focused field, then restores the user's clipboard (ADR-DESK-002). */
  async paste(text: string): Promise<void> {
    await this.helper.request("insert", { text, restoreDelay: config.clipboardRestoreDelay / 1000 }, config.helperRequestTimeout + config.clipboardRestoreDelay);
  }

  /** The process of the app in front. */
  async frontmostApp(): Promise<number | null> {
    const app = await this.helper.request<{ pid?: unknown } | null>("frontmostApp");
    return typeof app?.pid === "number" ? app.pid : null;
  }

  async keyboardLanguage(): Promise<string | null> {
    const { code } = await this.helper.request<{ code: string | null }>("keyboardLanguage");
    return code;
  }

  /** The bundle identifier of the default email app. */
  async systemEmailApp(): Promise<string | null> {
    const { systemDefault } = await this.helper.request<{ systemDefault: { bundleIdentifier: string } | null }>("emailApps", { bundleIdentifiers: [] });
    return systemDefault?.bundleIdentifier ?? null;
  }

  /** The default email app and which of `bundleIdentifiers` are installed, for Settings. */
  emailApps(bundleIdentifiers: readonly string[]): Promise<{ systemDefault: EmailAppInfo | null; installed: EmailAppInfo[] }> {
    return this.helper.request("emailApps", { bundleIdentifiers });
  }

  /** The icon of the app at `path`, `pixels` square, as a PNG data URL; null when it can't be drawn.
   * The helper draws it: Electron's `app.getFileIcon` can hand back the system's blank placeholder. */
  async appIcon(path: string, pixels: number): Promise<string | null> {
    const { png } = await this.helper.request<{ png: string | null }>("appIcon", { path, pixels });
    return png === null ? null : `data:image/png;base64,${png}`;
  }

  /** The screen context of the app in front; null without one. */
  readScreen(): Promise<ScreenContext | null> {
    return this.helper.request<ScreenContext | null>("readScreen", {}, config.screenReadTimeout);
  }

  /** The caret's (or the focused field's) rect in `pid`, in top-left screen points; null when it
   * exposes none. */
  caretAnchor(pid: number): Promise<Rect | null> {
    return this.helper.request<Rect | null>("caretAnchor", { pid });
  }

  /** Asks Gecko and Electron apps to build their accessibility tree as they come to the front. */
  async startActivator(): Promise<void> {
    await this.helper.request("startActivator");
  }

  readonly globeKey: GlobeKeySystem = {
    read: async () => (await this.helper.request<{ value: number | null }>("globeRead")).value,
    update: async (value) => {
      await this.helper.request("globeUpdate", { value });
    },
  };

  readonly thunderbird: ThunderbirdSystem = {
    applicationPath: async (app) => (await this.helper.request<{ path: string | null }>("appPath", { bundleIdentifier: app })).path,
    isRunning: (app) => this.flag("isRunning", app),
    launch: async (path) => {
      await this.helper.request("launch", { path });
    },
    hasWindow: (app) => this.flag("hasWindow", app),
    activate: async (app) => {
      await this.helper.request("activate", { bundleIdentifier: app });
    },
    isFrontmost: (app) => this.flag("isFrontmost", app),
    focusedElement: (app) => this.helper.request<FocusedElement | null>("focusedElement", { bundleIdentifier: app }),
    openChat: async () => {
      await this.helper.request("openTabMailChat");
    },
    paste: (text) => this.paste(text),
    pressReturn: async () => {
      await this.helper.request("pressReturn");
    },
  };

  private async flag(method: string, app: string): Promise<boolean> {
    return (await this.helper.request<{ value: boolean }>(method, { bundleIdentifier: app })).value;
  }
}

export interface EmailAppInfo {
  bundleIdentifier: string;
  name: string;
  path: string;
}
