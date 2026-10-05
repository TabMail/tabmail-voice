// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { Menu, type MenuItemConstructorOptions, nativeImage, type NativeImage, nativeTheme, Tray } from "electron";
import { linuxTrayIcon, linuxTrayUsesLightText } from "./native/linux/trayIcon.js";
import { isReady, type MenuState, showsDictationButton, statusLine, updateItem } from "../core/ui/menuModel.js";

/** What the menu's items do. */
export interface TrayActions {
  showWelcome(): void;
  showSettings(): void;
  requestMicrophone(): void;
  requestAccessibility(): void;
  toggleDictation(): void;
  quit(): void;
  checkForUpdates(): void;
  installUpdate(): void;
  /** Debug builds with debug mode on only; null otherwise. */
  debug: {
    hasLastRecording(): boolean;
    playLastRecording(): void;
    showLastScreenContext(): void;
    showLogFile(): void;
  } | null;
}

/** The menu-bar icon and its menu (`MenuContent` in the Swift app), rebuilt whenever its state
 * changes. */
export class TrayMenu {
  private readonly tray: Tray;
  private readonly icon: (marked: boolean) => NativeImage;
  /** Whether the icon shows the mark: a dot beside the glyph while a permission is missing. */
  private marked = false;

  constructor(
    resources: string,
    private readonly state: () => MenuState,
    private readonly actions: TrayActions,
  ) {
    const template = (name: string) => {
      const image = nativeImage.createFromPath(join(resources, name));
      image.setTemplateImage(true);
      return image;
    };
    const plain = template("trayTemplate.png");
    const marked = template("trayTemplateMarked.png");
    this.icon = (mark) => {
      const image = mark ? marked : plain;
      return process.platform === "linux" ? linuxTrayIcon(image, linuxTrayUsesLightText(process.env.XDG_CURRENT_DESKTOP ?? "", nativeTheme.shouldUseDarkColors)) : image;
    };
    this.tray = new Tray(this.icon(false));
    if (process.platform === "linux") nativeTheme.on("updated", () => this.tray.setImage(this.icon(this.marked)));
    this.tray.setToolTip("TabMail Voice");
    this.update();
  }

  update(): void {
    const state = this.state();
    const marked = !state.microphoneGranted || !state.accessibilityTrusted;
    if (marked !== this.marked) {
      this.marked = marked;
      this.tray.setImage(this.icon(marked));
      this.tray.setToolTip(marked ? "TabMail Voice needs a permission" : "TabMail Voice");
    }
    this.tray.setContextMenu(Menu.buildFromTemplate(this.items(state)));
  }

  private items(state: MenuState): MenuItemConstructorOptions[] {
    const actions = this.actions;
    const items: MenuItemConstructorOptions[] = [{ label: statusLine(state), enabled: false }];
    if (!state.hasConsented) items.push({ label: "Finish Setting Up TabMail Voice…", click: () => actions.showWelcome() });
    if (!state.isSignedIn) items.push({ label: "Sign In to TabMail…", click: () => actions.showSettings() });
    if (!state.microphoneGranted) items.push({ label: "Allow Microphone Access…", click: () => actions.requestMicrophone() });
    if (!state.accessibilityTrusted) items.push({ label: "Allow Accessibility Access…", click: () => actions.requestAccessibility() });

    if (showsDictationButton(state.debugMode, state.phase)) {
      const listening = state.phase.kind === "listening";
      items.push(
        { type: "separator" },
        // Stop stays available while recording, even if setup has since become incomplete.
        { label: listening ? "Stop Dictation" : "Start Dictation", enabled: listening || isReady(state), click: () => actions.toggleDictation() },
      );
    }

    if (actions.debug && state.debugMode) {
      const debug = actions.debug;
      items.push(
        { type: "separator" },
        { label: "Play Last Recording", enabled: debug.hasLastRecording(), click: () => debug.playLastRecording() },
        { label: "Show Last Screen Context", click: () => debug.showLastScreenContext() },
        { label: "Show Log File", click: () => debug.showLogFile() },
      );
    }

    items.push(
      { type: "separator" },
      { label: "Welcome Guide…", click: () => actions.showWelcome() },
      { label: "Settings…", accelerator: "CommandOrControl+,", click: () => actions.showSettings() },
    );
    const update = state.update;
    if (update) {
      const { label, enabled, install } = updateItem(update);
      items.push({ label, enabled, click: () => (install ? actions.installUpdate() : actions.checkForUpdates()) });
    }
    items.push(
      { label: "Quit TabMail Voice", accelerator: "CommandOrControl+Q", click: () => actions.quit() },
    );
    return items;
  }
}
