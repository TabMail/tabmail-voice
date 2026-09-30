// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from "electron";
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
  restartToUpdate(): void;
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

  constructor(
    resources: string,
    private readonly state: () => MenuState,
    private readonly actions: TrayActions,
  ) {
    const icon = nativeImage.createFromPath(join(resources, "trayTemplate.png"));
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("TabMail Voice");
    this.update();
  }

  update(): void {
    this.tray.setContextMenu(Menu.buildFromTemplate(this.items(this.state())));
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
    if (update) items.push({ ...updateItem(update), click: () => (update.kind === "ready" ? actions.restartToUpdate() : actions.checkForUpdates()) });
    items.push(
      { label: "Quit TabMail Voice", accelerator: "CommandOrControl+Q", click: () => actions.quit() },
    );
    return items;
  }
}
