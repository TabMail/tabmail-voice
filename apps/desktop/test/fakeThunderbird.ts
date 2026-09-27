// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ThunderbirdRelay } from "../src/core/agent/thunderbirdRelay.js";

/** A pretend Thunderbird for `ThunderbirdRelay`: no app is launched, no keystroke posted. Records
 * what the relay did to it, in order. */
export class FakeThunderbird {
  static readonly chatTitle = "TabMail Chat";
  static readonly app = "org.example.mail";
  static readonly path = "/Applications/Thunderbird.app";

  installed = true;
  running = true;
  hasWindow = true;
  frontmost = false;
  /** Whether asking Thunderbird to the front works. */
  comesToFront = true;
  focusedTitle: string | null = "Inbox - Thunderbird";
  /** For this many reads after the shortcut opens the chat, the chat is still loading: its window
   * has its title, but the focus is on the page, not its input, and a paste goes nowhere. */
  chatLoadingReads = 0;
  /** Whether the open-chat shortcut opens the chat. */
  shortcutOpensChat = true;
  /** Whether launching shows a window. */
  launchShowsWindow = true;
  /** How many checks find no window, then Thunderbird not in front, before they do: a slow launch
   * or activation. */
  windowLag = 0;
  frontLag = 0;
  /** Runs when the shortcut is posted, after the chat (if it opens) has focus. */
  onOpenChat: ((fake: FakeThunderbird) => void) | undefined;
  /** Whether the user switches away as the message is pasted. */
  loseFocusOnPaste = false;
  /** Runs during the `n`th read of the focused window's title (from 1), before it answers. */
  onTitleRead: ((fake: FakeThunderbird, n: number) => void) | undefined;
  private titleReads = 0;
  readonly events: string[] = [];
  /** Every app the relay asked about, in order, without repeats. */
  readonly apps: string[] = [];
  readonly pasted: string[] = [];

  private asked(app: string): void {
    if (this.apps.at(-1) !== app) this.apps.push(app);
  }

  /** A relay on this Thunderbird, with waits short enough for tests. */
  relay(chatTimeout = 200): ThunderbirdRelay {
    return new ThunderbirdRelay(
      {
        applicationPath: async (app) => {
          this.asked(app);
          return this.installed ? FakeThunderbird.path : null;
        },
        isRunning: async (app) => {
          this.asked(app);
          return this.running;
        },
        launch: async () => {
          this.events.push("launch");
          this.running = true;
          this.hasWindow = this.launchShowsWindow;
          this.frontmost = this.launchShowsWindow;
        },
        hasWindow: async (app) => {
          this.asked(app);
          if (this.windowLag > 0) {
            this.windowLag -= 1;
            return false;
          }
          return this.hasWindow;
        },
        activate: async (app) => {
          this.asked(app);
          this.events.push("activate");
          if (this.comesToFront) this.frontmost = true;
        },
        isFrontmost: async (app) => {
          this.asked(app);
          if (this.frontLag > 0) {
            this.frontLag -= 1;
            return false;
          }
          return this.frontmost;
        },
        focusedElement: async (app) => {
          this.asked(app);
          this.titleReads += 1;
          this.onTitleRead?.(this, this.titleReads);
          // Answers after a turn, as a request to the helper does.
          await new Promise((resolve) => setTimeout(resolve, 0));
          const loading = this.chatLoadingReads > 0;
          if (loading) this.chatLoadingReads -= 1;
          return { role: loading ? "AXWebArea" : "AXTextArea", windowTitle: this.focusedTitle };
        },
        openChat: async () => {
          this.events.push("openChat");
          if (this.shortcutOpensChat) this.focusedTitle = FakeThunderbird.chatTitle;
          this.onOpenChat?.(this);
        },
        paste: async (text) => {
          this.events.push("paste");
          if (this.chatLoadingReads === 0) this.pasted.push(text);
          if (this.loseFocusOnPaste) this.frontmost = false;
        },
        pressReturn: async () => {
          this.events.push("return");
        },
      },
      { launchTimeout: 200, addonSettle: 0, activateTimeout: 200, chatTimeout, pollInterval: 10 },
    );
  }
}
