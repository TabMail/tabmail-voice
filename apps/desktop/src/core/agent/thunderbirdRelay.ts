// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { log } from "../log.js";
import { charCount } from "../text.js";
import { CancellationError, sleep } from "../timeout.js";

/** What the relay does to the system, to the email app named by its bundle identifier. Injected so
 * tests drive it without launching apps or posting keystrokes; on macOS the helper does it all. */
export interface ThunderbirdSystem {
  /** The app's bundle, when installed. */
  applicationPath(app: string): Promise<string | null>;
  isRunning(app: string): Promise<boolean>;
  launch(path: string): Promise<void>;
  /** True once the app shows a window. */
  hasWindow(app: string): Promise<boolean>;
  /** Asks the app to come to the front. */
  activate(app: string): Promise<void>;
  isFrontmost(app: string): Promise<boolean>;
  /** The app's focused element, if any. */
  focusedElement(app: string): Promise<FocusedElement | null>;
  /** Posts the add-on's open-chat shortcut. */
  openChat(): Promise<void>;
  /** Pastes into the focused field. */
  paste(text: string): Promise<void>;
  /** Posts Return, which sends the chat message. */
  pressReturn(): Promise<void>;
}

/** An element's Accessibility role and the title of the window it is in. */
export interface FocusedElement {
  role: string | null;
  windowTitle: string | null;
}

export type RelayFailureKind = "notInstalled" | "didNotLaunch" | "notFrontmost" | "chatNotFocused";

export class RelayFailure extends Error {
  constructor(readonly kind: RelayFailureKind) {
    super(
      kind === "notInstalled" ? "Mail and calendar requests need Thunderbird with TabMail."
        : kind === "didNotLaunch" ? "Thunderbird didn't open. Try again."
          : kind === "notFrontmost" ? "Couldn't bring Thunderbird to the front."
            // The chat window did not open, or lost focus before the message was in.
            : "Couldn't open TabMail's chat in Thunderbird.",
    );
    this.name = "RelayFailure";
  }

  get description(): string {
    return `RelayFailure.${this.kind}`;
  }
}

/** How long each step may take, in ms. */
export interface RelayTimings {
  launchTimeout: number;
  addonSettle: number;
  activateTimeout: number;
  chatTimeout: number;
  pollInterval: number;
}

export const relayTimings: RelayTimings = {
  launchTimeout: config.thunderbirdLaunchTimeout,
  addonSettle: config.thunderbirdAddonSettle,
  activateTimeout: config.thunderbirdActivateTimeout,
  chatTimeout: config.thunderbirdChatTimeout,
  pollInterval: config.thunderbirdPollInterval,
};

/**
 * Sends a chat message to TabMail's chat in Thunderbird by driving Thunderbird from outside: bring
 * it to the front (launching it first if it isn't running), open the chat with the add-on's shortcut
 * (⌥⌘L), paste the message and press Return. A spike that needs no Thunderbird change
 * (ADR-DESK-014); it never pastes unless the TabMail chat's input has focus.
 */
export class ThunderbirdRelay {
  constructor(
    private readonly system: ThunderbirdSystem,
    private readonly timings: RelayTimings = relayTimings,
  ) {}

  /** The bundle of the email app `app`, when there is one and it is installed. */
  async applicationPath(app: string | null): Promise<string | null> {
    return app === null ? null : this.system.applicationPath(app);
  }

  /** Types `message` into TabMail's chat in the email app `app` (a bundle identifier, from the
   * dictation's settings) and sends it. Throws `RelayFailure`, or `CancellationError` once `signal`
   * aborts; either way nothing is pasted outside that app's chat window. */
  async send(message: string, app: string | null, signal: AbortSignal): Promise<void> {
    const path = app === null ? null : await this.system.applicationPath(app);
    if (app === null || path === null) throw new RelayFailure("notInstalled");
    if (!(await this.system.isRunning(app))) {
      log.debug("ThunderbirdRelay: launching Thunderbird");
      await this.system.launch(path);
      if (!(await this.wait(this.timings.launchTimeout, () => this.system.hasWindow(app), signal))) throw new RelayFailure("didNotLaunch");
      // The add-on registers its shortcut only once its background page has loaded.
      await sleep(this.timings.addonSettle, signal);
    }
    await this.system.activate(app);
    if (!(await this.wait(this.timings.activateTimeout, () => this.system.isFrontmost(app), signal))) throw new RelayFailure("notFrontmost");
    if (!(await this.isChatFocused(app))) {
      // The shortcut goes to whatever app is in front, and the user may have switched, or
      // cancelled, during the focus read.
      if (!(await this.system.isFrontmost(app))) throw new RelayFailure("notFrontmost");
      checkCancellation(signal);
      log.debug("ThunderbirdRelay: opening the chat");
      await this.system.openChat();
      if (!(await this.wait(this.timings.chatTimeout, () => this.isChatFocused(app), signal))) throw new RelayFailure("chatNotFocused");
      log.debug("ThunderbirdRelay: the chat is ready");
    }
    // The user may have moved on, or cancelled, while this waited: paste and send only into the
    // chat, and only for a request still wanted.
    if (!(await this.isChatFocused(app))) throw new RelayFailure("chatNotFocused");
    checkCancellation(signal);
    await this.system.paste(message);
    if (!(await this.isChatFocused(app))) throw new RelayFailure("chatNotFocused");
    checkCancellation(signal);
    await this.system.pressReturn();
    log.debug(() => `ThunderbirdRelay: sent ${charCount(message)} chars`);
    log.content("ThunderbirdRelay: sent", message);
  }

  /** Whether the chat is ready for a message: its input has focus, which the chat gives it only
   * once it has loaded (a chat just opened has its title well before). The focus is read first:
   * `app` being in front is only a fact after the read's `await`. The whole title must match; a
   * window that merely mentions the chat, such as a draft replying to a message about it
   * ("Write: Re: TabMail Chat feedback"), is not it. */
  private async isChatFocused(app: string): Promise<boolean> {
    const focused = await this.system.focusedElement(app);
    if (!focused || !(await this.system.isFrontmost(app))) return false;
    return focused.role === config.thunderbirdChatInputRole && focused.windowTitle === config.thunderbirdChatWindowTitle;
  }

  /** Whether `condition` holds within `timeout` ms, checking every `pollInterval`. */
  private async wait(timeout: number, condition: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
    const deadline = performance.now() + timeout;
    while (!(await condition())) {
      if (performance.now() >= deadline) return false;
      await sleep(this.timings.pollInterval, signal);
    }
    return true;
  }
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError();
}
