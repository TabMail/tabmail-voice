// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { RelayError, type RelayErrorKind, ThunderbirdRelay } from "../../../../../src/core/agent/connectors/thunderbird/relay.js";
import { CancellationError } from "../../../../../src/core/util/timeout.js";
import { FakeThunderbird } from "../../../../support/fakeThunderbird.js";

const message = "Find the invoice Sam sent last week.";

function send(thunderbird: FakeThunderbird, app: string | null = FakeThunderbird.app, signal = new AbortController().signal): Promise<void> {
  return thunderbird.relay().send(message, app, signal);
}

async function failure(promise: Promise<unknown>): Promise<RelayErrorKind | "cancelled" | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RelayError) return error.kind;
    if (error instanceof CancellationError) return "cancelled";
    throw error;
  }
  return undefined;
}

/** `ThunderbirdRelay` against a pretend Thunderbird. The invariant: the message is pasted, and
 * Return pressed, only while TabMail's chat window in Thunderbird has focus; the open-chat shortcut
 * is posted only while Thunderbird is in front. */
describe("ThunderbirdRelay", () => {
  /** A window in the other installed mail app cannot satisfy the chosen app's cold-launch wait. */
  test.each([true, false])("a cold launch waits for the chosen app's own window (shows window: %s)", async (showsWindow) => {
    const chosen = "org.example.chosen-mail";
    const other = "org.example.wrong-app";
    const chosenPath = "/Applications/ChosenMail.app";
    const otherPath = "/Applications/OtherMail.app";
    const running = new Set([other]);
    const windows = new Set([other]);
    let front = other;
    let chosenWindowChecks = 0;
    const texts: Record<string, string[]> = { [chosen]: [], [other]: ["Unrelated draft"] };
    const returns: string[] = [];
    const launched: string[] = [];
    const relay = new ThunderbirdRelay(
      {
        applicationPath: async (app) => (app === chosen ? chosenPath : app === other ? otherPath : null),
        isRunning: async (app) => running.has(app),
        launch: async (path) => {
          launched.push(path);
          if (path === chosenPath) running.add(chosen);
        },
        hasWindow: async (app) => {
          if (app === chosen) {
            chosenWindowChecks += 1;
            if (showsWindow && chosenWindowChecks >= 3) windows.add(chosen);
          }
          return windows.has(app);
        },
        activate: async (app) => {
          if (windows.has(app)) front = app;
        },
        isFrontmost: async (app) => front === app,
        focusedElement: async (app) => (windows.has(app) ? { role: "AXTextArea", windowTitle: FakeThunderbird.chatTitle } : null),
        openChat: async () => {},
        paste: async (text) => {
          (texts[front] ??= []).push(text);
        },
        pressReturn: async () => {
          returns.push(front);
        },
      },
      { launchTimeout: 500, addonSettle: 0, activateTimeout: 100, chatTimeout: 100, pollInterval: 5 },
    );

    const result = await failure(relay.send(message, chosen, new AbortController().signal));

    if (showsWindow) {
      expect(result).toBeUndefined();
      expect(texts[chosen]).toEqual([message]);
      expect(returns).toEqual([chosen]);
    } else {
      expect(result).toBe("didNotLaunch");
      expect(texts[chosen]).toEqual([]);
      expect(returns).toEqual([]);
    }
    expect(launched).toEqual([chosenPath]);
    expect(texts[other]).toEqual(["Unrelated draft"]);
    expect(chosenWindowChecks).toBeGreaterThanOrEqual(showsWindow ? 3 : 1);
  });

  /** Every step is about the email app the send was given, the dictation's. */
  test("sends into an open chat without the shortcut", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.focusedTitle = FakeThunderbird.chatTitle;

    await send(thunderbird);

    expect(thunderbird.events).toEqual(["activate", "paste", "return"]);
    expect(thunderbird.pasted).toEqual([message]);
    expect(thunderbird.apps).toEqual([FakeThunderbird.app]);
  });

  test("opens the chat with the shortcut", async () => {
    const thunderbird = new FakeThunderbird();

    await send(thunderbird);

    expect(thunderbird.events).toEqual(["activate", "openChat", "paste", "return"]);
    expect(thunderbird.pasted).toEqual([message]);
  });

  /** A window that only mentions the chat is not it: a draft replying to a message about it, or
   * the main window showing a message whose subject starts with its name, would otherwise get the
   * message pasted in, and Return pressed. On macOS Thunderbird titles the chat's popup window with
   * the page title alone. */
  test.each([
    "Write: Re: TabMail Chat feedback - Thunderbird",
    "TabMail Chat feedback - Mozilla Thunderbird",
    "TabMail Chat - support thread",
    "TabMail Chat — Mozilla Thunderbird",
    "Re: TabMail Chat",
  ])("a window that only mentions the chat gets nothing: %s", async (title) => {
    const thunderbird = new FakeThunderbird();
    thunderbird.focusedTitle = title;
    thunderbird.shortcutOpensChat = false;

    expect(await failure(send(thunderbird))).toBe("chatNotFocused");
    expect(thunderbird.events).toEqual(["activate", "openChat"]);
    expect(thunderbird.pasted).toEqual([]);
  });

  /** A window whose title can't be read (none has focus, Thunderbird is hung, or it quit) is not
   * the chat. */
  test("a window with no readable title gets nothing", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.focusedTitle = null;
    thunderbird.shortcutOpensChat = false;

    expect(await failure(send(thunderbird))).toBe("chatNotFocused");
    expect(thunderbird.events).toEqual(["activate", "openChat"]);
    expect(thunderbird.pasted).toEqual([]);
  });

  test("launches Thunderbird when it is not running", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.running = false;
    thunderbird.hasWindow = false;

    await send(thunderbird);

    expect(thunderbird.events).toEqual(["launch", "activate", "openChat", "paste", "return"]);
  });

  test("a Thunderbird that shows no window fails", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.running = false;
    thunderbird.hasWindow = false;
    thunderbird.launchShowsWindow = false;

    expect(await failure(send(thunderbird))).toBe("didNotLaunch");
    expect(thunderbird.events).toEqual(["launch"]);
  });

  /** No email app set up, or one that isn't installed: nothing happens. */
  test.each([null, FakeThunderbird.app])("without Thunderbird nothing happens (app %s)", async (app) => {
    const thunderbird = new FakeThunderbird();
    thunderbird.installed = false;

    expect(await failure(send(thunderbird, app))).toBe("notInstalled");
    expect(thunderbird.events).toEqual([]);
  });

  /** The shortcut goes to whatever app is in front: it is never posted unless Thunderbird is. */
  test("a Thunderbird that stays behind gets no shortcut", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.comesToFront = false;

    expect(await failure(send(thunderbird))).toBe("notFrontmost");
    expect(thunderbird.events).toEqual(["activate"]);
  });

  /** A chat just opened has its title before it is ready for a message: the message waits for its
   * input to take focus, and a chat that never gets ready gets nothing. */
  test.each([3, 1000])("a chat still loading is waited for (%i loading reads)", async (loadingReads) => {
    const thunderbird = new FakeThunderbird();
    thunderbird.chatLoadingReads = loadingReads;

    const result = await failure(send(thunderbird));

    if (loadingReads < 10) {
      expect(result).toBeUndefined();
      expect(thunderbird.pasted).toEqual([message]);
      expect(thunderbird.events).toEqual(["activate", "openChat", "paste", "return"]);
    } else {
      expect(result).toBe("chatNotFocused");
      expect(thunderbird.events).not.toContain("paste");
      expect(thunderbird.events).not.toContain("return");
    }
  });

  test("a chat that never opens gets nothing", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.shortcutOpensChat = false;

    expect(await failure(send(thunderbird))).toBe("chatNotFocused");
    expect(thunderbird.events).toEqual(["activate", "openChat"]);
    expect(thunderbird.pasted).toEqual([]);
  });

  /** The user switched away while the chat's input settled: nothing is pasted where they went. */
  test("focus lost while the chat loads gets nothing", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.chatLoadingReads = 1000;
    thunderbird.onOpenChat = (fake) => {
      setTimeout(() => {
        fake.frontmost = false;
        fake.chatLoadingReads = 0;
      }, 50);
    };

    expect(await failure(send(thunderbird))).toBe("chatNotFocused");
    expect(thunderbird.pasted).toEqual([]);
    expect(thunderbird.events).not.toContain("return");
  });

  /** Return could submit something in another app: it is pressed only if the chat still has focus. */
  test("focus lost during the paste presses no Return", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.loseFocusOnPaste = true;

    expect(await failure(send(thunderbird))).toBe("chatNotFocused");
    expect(thunderbird.events).toEqual(["activate", "openChat", "paste"]);
  });

  /** Thunderbird is in front only as of the last check: the user switching away while the chat's
   * title is read (before the paste, or before Return) gets nothing in the app they went to. */
  test.each([
    [2, []],
    [3, ["paste"]],
  ])("switching away during title read %i gets nothing", async (read, sentBefore) => {
    const thunderbird = new FakeThunderbird();
    thunderbird.focusedTitle = FakeThunderbird.chatTitle;
    thunderbird.onTitleRead = (fake, n) => {
      if (n === read) fake.frontmost = false;
    };

    expect(await failure(send(thunderbird))).toBe("chatNotFocused");
    expect(thunderbird.events).toEqual(["activate", ...sentBefore]);
  });

  /** A slow Thunderbird: its window, its coming to the front and its chat opening are each waited
   * for, and the message then sent once. */
  test.each(["window", "front", "chat"])("waits for a slow Thunderbird (%s)", async (stage) => {
    const thunderbird = new FakeThunderbird();
    if (stage === "window") {
      thunderbird.running = false;
      thunderbird.hasWindow = false;
      thunderbird.windowLag = 3;
    } else if (stage === "front") {
      thunderbird.frontLag = 3;
    } else {
      thunderbird.shortcutOpensChat = false;
      thunderbird.onTitleRead = (fake, n) => {
        if (n === 3) fake.focusedTitle = FakeThunderbird.chatTitle;
      };
    }

    await send(thunderbird);

    expect(thunderbird.events).toEqual([...(stage === "window" ? ["launch"] : []), "activate", "openChat", "paste", "return"]);
    expect(thunderbird.pasted).toEqual([message]);
  });

  /** The user switching away while the title is first read gets no shortcut in the app they went
   * to, whether or not the chat has focus in Thunderbird. */
  test.each([FakeThunderbird.chatTitle, "Inbox - Thunderbird"])("switching away during the first title read gets no shortcut (%s)", async (title) => {
    const thunderbird = new FakeThunderbird();
    thunderbird.focusedTitle = title;
    thunderbird.onTitleRead = (fake, n) => {
      if (n === 1) fake.frontmost = false;
    };

    expect(await failure(send(thunderbird))).toBe("notFrontmost");
    expect(thunderbird.events).toEqual(["activate"]);
  });

  /** Cancelled while the chat's title is read (before the shortcut, the paste, or Return): nothing
   * more is sent. */
  test.each([
    [1, "Inbox - Thunderbird", []],
    [2, FakeThunderbird.chatTitle, []],
    [3, FakeThunderbird.chatTitle, ["paste"]],
  ])("cancelled during title read %i sends nothing more", async (read, title, sentBefore) => {
    const thunderbird = new FakeThunderbird();
    thunderbird.focusedTitle = title;
    const controller = new AbortController();
    thunderbird.onTitleRead = (_fake, n) => {
      if (n === read) controller.abort();
    };

    expect(await failure(send(thunderbird, FakeThunderbird.app, controller.signal))).toBe("cancelled");
    expect(thunderbird.events).toEqual(["activate", ...sentBefore]);
  });

  /** Cancelled while the relay reads whether Thunderbird runs: a newer dictation may have started,
   * so Thunderbird is neither launched nor brought to the front. */
  test.each([true, false])("cancelled before Thunderbird is reached (running: %s) touches no app", async (running) => {
    const thunderbird = new FakeThunderbird();
    thunderbird.running = running;
    const controller = new AbortController();
    thunderbird.onRunningRead = () => controller.abort();

    expect(await failure(send(thunderbird, FakeThunderbird.app, controller.signal))).toBe("cancelled");
    expect(thunderbird.events).toEqual([]);
  });

  test("cancelled while waiting for the chat pastes nothing", async () => {
    const thunderbird = new FakeThunderbird();
    thunderbird.shortcutOpensChat = false;
    const controller = new AbortController();
    const sending = failure(thunderbird.relay(30_000).send(message, FakeThunderbird.app, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));

    controller.abort();

    expect(await sending).toBe("cancelled");
    expect(thunderbird.pasted).toEqual([]);
    expect(thunderbird.events).not.toContain("return");
  });
});
