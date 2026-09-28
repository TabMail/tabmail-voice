// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../src/core/config.js";
import type { DictationTip } from "../../src/core/tips.js";
import type { AgentChat } from "../../src/core/agent/agentChat.js";
import type { Command, OverlayState } from "../../src/shared/ipc.js";

/** Each React root the page creates, to unmount as the window closes. */
const mounted = vi.hoisted(() => ({ roots: [] as { unmount(): void }[] }));
vi.mock("react-dom/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...real,
    createRoot: (...args: Parameters<typeof real.createRoot>) => {
      const root = real.createRoot(...args);
      mounted.roots.push(root);
      return root;
    },
  };
});

/** The size observers observing now, each able to report a new layout. */
const observers = new Set<{ changed(): void }>();

/** Sizes as the page lays them out (happy-dom lays nothing out): the pill's and the tip's. */
const pillSize = { width: 180, height: 30 };
const tipSize = { width: 200, height: 73 };
const chatSize = { width: 380, height: 146 };

function laidOut(element: HTMLElement): { width: number; height: number } {
  if (element.classList.contains("pill-anchor")) return pillSize;
  if (element.classList.contains("chat")) return chatSize;
  if (element.querySelector(".tip") || element.classList.contains("tip")) return tipSize;
  return { width: 0, height: 0 };
}

const listening: OverlayState = { phase: { kind: "listening" }, mode: "dictation", level: 0.5, isHearing: true, language: "en", tip: null, opensUpward: false, hotkey: "function", tools: [], emailAppIcon: null, chat: null, chatOpensUpward: false };
const warmingUp: OverlayState = { ...listening, isHearing: false };
const idle: OverlayState = { ...listening, phase: { kind: "idle" } };
const running: OverlayState = { ...listening, phase: { kind: "running", tool: "answer" }, mode: "agent" };

/** The overlay page, mounted afresh; `show` pushes it a state as the main process does. */
async function overlayPage(): Promise<{ show(state: OverlayState): Promise<void>; tipFrame(): { top: number; bottom: number } | null; pillFrame(): { top: number; bottom: number }; commands: Command[] }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  let listener: ((state: OverlayState) => void) | null = null;
  const commands: Command[] = [];
  vi.stubGlobal("voice", {
    send: async (command: Command) => {
      commands.push(command);
      return { error: null };
    },
    onState: (_name: string, next: (state: OverlayState) => void) => {
      listener = next;
      return () => {};
    },
  });
  // Reports each observed element's laid-out size, as a browser does once it is laid out.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(readonly changed: () => void) {}
      observe(): void {
        observers.add(this);
        queueMicrotask(() => this.changed());
      }
      disconnect(): void {
        observers.delete(this);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return laidOut(this).width;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return laidOut(this).height;
  });
  HTMLElement.prototype.animate ??= (() => ({})) as never;
  vi.resetModules();
  await act(async () => {
    await import("../../src/renderer/overlay.js");
  });
  const frame = (element: Element | null, height: number) => {
    if (!(element instanceof HTMLElement)) return null;
    // `.centred` elements are placed by their centre; `.pill-anchor` by its top.
    const top = parseFloat(element.style.top) - (element.classList.contains("centred") ? height / 2 : 0);
    return { top, bottom: top + height };
  };
  return {
    show: (state) =>
      act(async () => {
        listener?.(state);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
    tipFrame: () => frame(document.querySelector(".tip")?.closest(".centred") ?? null, tipSize.height),
    pillFrame: () => frame(document.querySelector(".pill-anchor"), pillSize.height) ?? { top: NaN, bottom: NaN },
    commands,
  };
}

async function unmount(): Promise<void> {
  await act(async () => {
    for (const root of mounted.roots.splice(0)) root.unmount();
  });
}

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("overlay page", () => {
  /** The hands-free tip, up the whole time it listens, goes over the pill in an overlay opened above
   * the caret's line, its arrow pointing down at the pill; opened below, it stays under the pill, and
   * a timed tip stays under it either way (owner, 2026-09-27: "above pill when opening up"). */
  test.each<[DictationTip, boolean, boolean]>([
    ["handsFree", true, true],
    ["handsFree", false, false],
    ["switchMode", true, false],
    ["doubleTap", true, false],
  ])("the %s tip, opened upward %s, is over the pill: %s", async (tip, opensUpward, over) => {
    const page = await overlayPage();
    await page.show({ ...listening, tip, opensUpward });

    const tipFrame = page.tipFrame();
    const pill = page.pillFrame();
    if (over) expect(tipFrame?.bottom).toBeLessThanOrEqual(pill.top);
    else expect(tipFrame?.top).toBeGreaterThanOrEqual(pill.bottom);
    // The arrow's room is on the pill's side, and the outline is drawn mirrored when it points down.
    const box = document.querySelector<HTMLElement>(".tip");
    expect(box?.style.paddingBottom !== "").toBe(over);
    expect(box?.style.paddingTop !== "").toBe(!over);
    // Mirrored in place: moved down by its own height as it flips, so it stays inside the tip.
    expect(document.querySelector(".tip-shape path")?.getAttribute("transform") ?? null).toBe(over ? `translate(0 ${tipSize.height}) scale(1 -1)` : null);
  });

  /** In agent mode the bubbles are above the pill too: an overlay opened upward puts the hands-free
   * tip over them, clear of every one (owner, 2026-09-27: "above pill when opening up"). */
  test("the hands-free tip opened upward clears agent mode's bubbles", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, mode: "agent", tools: ["compose", "thunderbird"], tip: "handsFree", opensUpward: true });

    const bubbleTops = [...document.querySelectorAll(".bubble")].map((bubble) => parseFloat((bubble.closest(".centred") as HTMLElement).style.top) - config.agentBubbleDiameter / 2);
    expect(bubbleTops).toHaveLength(2);
    const tipFrame = page.tipFrame();
    expect(tipFrame).not.toBeNull();
    for (const top of bubbleTops) expect(tipFrame?.bottom).toBeLessThanOrEqual(top);
  });

  /** A tip that appears during a hold (the double-tap tip, 20 s in, with the Space tip learned) is
   * placed as one shown from the start is: under the pill, not over it. */
  test("a tip that appears later is placed under the pill, as one shown from the start", async () => {
    const atStart = await overlayPage();
    await atStart.show({ ...listening, tip: "doubleTap" });
    const expected = atStart.tipFrame();
    expect(expected).not.toBeNull();
    expect(expected?.top).toBeGreaterThanOrEqual(atStart.pillFrame().bottom);

    const later = await overlayPage();
    await later.show(listening);
    expect(later.tipFrame()).toBeNull();
    await later.show({ ...listening, tip: "doubleTap" });

    expect(later.tipFrame()).toEqual(expected);
    expect(later.tipFrame()?.top).toBeGreaterThanOrEqual(later.pillFrame().bottom);
  });

  /** As the Swift swirl's opacity transition: it fades in, so its wide starting ring shows faintly,
   * and fades out still circling while the pill appears, then goes, however many states the page is
   * pushed meanwhile; a new hold's swirl gathers afresh. */
  test("the warm-up swirl fades in, fades out as the pill appears, then goes", async () => {
    const page = await overlayPage();
    const fades: { element: Element; opacity: unknown[]; fill: unknown }[] = [];
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, keyframes, options) {
      if (this.classList.contains("swirl")) fades.push({ element: this, opacity: (keyframes as Keyframe[]).map((frame) => frame.opacity), fill: (options as KeyframeAnimationOptions).fill });
      return {} as Animation;
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, config.pillSpringResponse * 1000 + 50));
    try {
      await page.show(warmingUp);
      const swirl = document.querySelector("canvas.swirl");
      expect(swirl).not.toBeNull();
      expect(fades).toEqual([{ element: swirl, opacity: [0, 1], fill: "backwards" }]);

      await page.show(listening);
      await page.show({ ...listening, level: 0.2 });
      expect(document.querySelector(".pill-anchor")).not.toBeNull();
      expect(document.querySelector("canvas.swirl")).toBe(swirl);
      expect(fades.at(-1)).toEqual({ element: swirl, opacity: [1, 0], fill: "forwards" });
      await act(settle);
      expect(document.querySelector("canvas.swirl")).toBeNull();

      await page.show(warmingUp);
      const fading = document.querySelector("canvas.swirl");
      await page.show(listening);
      await page.show(idle);
      await page.show(warmingUp);
      // A hold during the last swirl's fade gets a fresh one, gathering from its start.
      const next = document.querySelectorAll("canvas.swirl");
      expect(next).toHaveLength(1);
      expect(next[0]).not.toBe(fading);
      expect(fades.at(-1)).toEqual({ element: next[0], opacity: [0, 1], fill: "backwards" });
      await act(settle);
      // The earlier swirl's removal leaves the new one circling.
      expect([...document.querySelectorAll("canvas.swirl")]).toEqual([next[0]]);
    } finally {
      animate.mockRestore();
    }
  });

  /** Released while it warms up: the swirl fades out beside the dispersing one, as the Swift app's
   * does, and both go; the next hold, heard at once, shows its pill with no swirl left behind it. */
  test("a swirl released while it warms up goes, leaving nothing behind the next pill", async () => {
    const page = await overlayPage();
    await page.show(warmingUp);
    await page.show(idle);
    expect(document.querySelectorAll("canvas.swirl")).toHaveLength(2);
    await act(() => new Promise((resolve) => setTimeout(resolve, config.pillSpringResponse * 1000 + 50)));

    await page.show({ ...listening, phase: { kind: "arming" } });
    await page.show(listening);
    expect(document.querySelector(".pill-anchor")).not.toBeNull();
    expect(document.querySelectorAll("canvas.swirl")).toHaveLength(0);
  });

  /** The pill growing moves the tip with it, and a closed page observes nothing more. */
  test("a pill that grows moves its tip, and unmounting stops observing", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, tip: "doubleTap" });
    const before = page.tipFrame();
    expect(before).not.toBeNull();
    expect(observers.size).toBeGreaterThan(0);

    const grownBy = 30;
    pillSize.height += grownBy;
    try {
      await act(async () => {
        for (const observer of observers) observer.changed();
      });
      expect(page.tipFrame()?.top).toBe((before?.top ?? 0) + grownBy);
      expect(page.tipFrame()?.top).toBeGreaterThanOrEqual(page.pillFrame().bottom);
    } finally {
      pillSize.height -= grownBy;
    }

    await unmount();
    expect(document.querySelector(".pill-anchor")).toBeNull();
    expect(observers.size).toBe(0);
  });
});

describe("the chat window", () => {
  /** An answer, then an Edit follow-up, with a third under way; untouched while it times out. */
  function chat(closesAt: number | null, touched = closesAt === null): AgentChat {
    return {
      turns: [
        { id: 0, request: "When do we ship", tool: "answer", reply: "We ship on **Friday**, see [the plan](https://example.com/plan)" },
        { id: 1, request: "Say it shorter", tool: "edit", reply: "Friday" },
      ],
      pendingRequest: "And the launch party",
      closesAt,
      touched,
      activity: null,
      confirmation: null,
    };
  }

  const texts = (selector: string) => [...document.querySelectorAll(selector)].map((element) => element.textContent);

  /** Each request and its reply, a request under way, and a follow-up's pill below them; an Edit reply
   * carries its caption, the answer none. The pill's own overlay is gone meanwhile. */
  test("it shows the conversation and a follow-up's pill", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: chat(Date.now() + config.chatTimeout) });

    expect(texts(".chat-request")).toEqual(["When do we ship", "Say it shorter", "And the launch party"]);
    expect(texts(".chat-text")).toEqual(["We ship on Friday, see the plan", "Friday"]);
    expect(texts(".chat-caption")).toEqual(["Replaced the selection"]);
    expect(document.querySelector(".chat-text strong")?.textContent).toBe("Friday");
    expect(document.querySelector(".chat-status")).toBeNull();
    expect(document.querySelector(".canvas")).toBeNull();

    await page.show({ ...listening, chat: chat(null) });
    expect(document.querySelector(".chat-status .pill")).not.toBeNull();
  });

  /** A reply's inline Markdown shows as it reads: code, bold, italics, struck-out text and a link,
   * each around its own words and none of the text around them. */
  test("a reply's inline Markdown shows as it reads", async () => {
    const page = await overlayPage();
    const reply = "Run `npm test`, **now**, *please*, ~~not~~ [the plan](https://example.com/plan)";
    await page.show({ ...idle, chat: { ...chat(null), turns: [{ id: 0, request: "What next", tool: "answer", reply }], pendingRequest: null } });

    expect(texts(".chat-text")).toEqual(["Run npm test, now, please, not the plan"]);
    expect(texts(".chat-text code")).toEqual(["npm test"]);
    expect(texts(".chat-text strong")).toEqual(["now"]);
    expect(texts(".chat-text em")).toEqual(["please"]);
    expect(texts(".chat-text s")).toEqual(["not"]);
    expect([...document.querySelectorAll(".chat-text a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["the plan", "https://example.com/plan"]]);
  });

  /** A follow-up warming up shows the pill, not the swirl: the chat window is where it listens. */
  test("a follow-up warming up shows its pill", async () => {
    const page = await overlayPage();
    await page.show({ ...warmingUp, chat: chat(null) });

    expect(document.querySelector(".chat-status .pill")).not.toBeNull();
  });

  /** Opened upward, the window sits at the bottom of its overlay, by the caret, until the overlay
   * fits it; downward, at the top. */
  test.each([
    [true, "flex-end"],
    [false, "flex-start"],
  ])("opened upward: %s, it sits at the %s", async (chatOpensUpward, justifyContent) => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: chat(null), chatOpensUpward });

    expect(document.querySelector<HTMLElement>(".chat-canvas")?.style.justifyContent).toBe(justifyContent);
  });

  /** A new turn scrolls the conversation to it. */
  test("it scrolls to the newest turn", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: { ...chat(null), pendingRequest: null } });
    const scroll = document.querySelector<HTMLElement>(".chat-scroll");
    if (!scroll) throw new Error("no .chat-scroll");
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 500 });
    scroll.scrollTop = 0;

    const longer = chat(null);
    await page.show({ ...idle, chat: { ...longer, turns: [...longer.turns, { id: 2, request: "And the launch party", tool: "answer", reply: "Saturday" }], pendingRequest: null } });

    expect(scroll.scrollTop).toBe(500);
  });

  /** A state that shows nothing new (a follow-up's level, a new copy of the same conversation, as
   * each push brings) leaves the conversation where the user scrolled it; the follow-up's status
   * changing, or its request joining, scrolls to it. */
  test("an update that shows nothing new leaves the scroll where the user put it", async () => {
    const page = await overlayPage();
    const followUp: OverlayState = { ...listening, mode: "agent", chat: { ...chat(null), pendingRequest: null } };
    await page.show(followUp);
    const scroll = document.querySelector<HTMLElement>(".chat-scroll");
    if (!scroll) throw new Error("no .chat-scroll");
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 500 });
    scroll.scrollTop = 120;

    await page.show({ ...followUp, level: 0.9, chat: structuredClone(followUp.chat) });
    await page.show({ ...followUp, level: 0.2, isHearing: false, chat: structuredClone(followUp.chat) });
    expect(scroll.scrollTop).toBe(120);

    const transcribing: OverlayState = { ...followUp, phase: { kind: "transcribing" }, chat: structuredClone(followUp.chat) };
    await page.show(transcribing);
    expect(scroll.scrollTop).toBe(500);
    scroll.scrollTop = 120;
    await page.show({ ...transcribing, chat: { ...chat(null), pendingRequest: "And the launch party" } });
    expect(scroll.scrollTop).toBe(500);

    // A tool's question, then its progress, joining a full window each scroll to it on its own, so its
    // buttons show; the same question pushed again doesn't.
    const loop: OverlayState = { ...running, chat: { ...chat(null), pendingRequest: "And the launch party" } };
    await page.show(loop);
    const shown = async (fields: Partial<AgentChat>, level = loop.level): Promise<number> => {
      scroll.scrollTop = 120;
      await page.show({ ...loop, level, chat: { ...(loop.chat as AgentChat), ...fields } });
      return scroll.scrollTop;
    };
    expect(await shown({ confirmation: "Add the launch party?" })).toBe(500);
    expect(document.querySelector(".chat-confirmation")).not.toBeNull();
    expect(await shown({ confirmation: "Add the launch party?" }, 0.4)).toBe(120);
    await shown({});
    expect(await shown({ activity: "Adding it to your calendar" })).toBe(500);
    expect(await shown({ activity: "Adding it to your calendar" }, 0.4)).toBe(120);
  });

  /** The timeout bar shows the time left while the window can still time out, and goes once it is
   * touched. */
  test("the timeout bar shows until the window is touched", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: chat(Date.now() + config.chatTimeout / 2) });

    const bar = document.querySelector<HTMLElement>(".chat-timeout");
    expect(parseFloat(bar?.style.width ?? "")).toBeGreaterThan(40);
    expect(parseFloat(bar?.style.width ?? "")).toBeLessThanOrEqual(50);

    await page.show({ ...idle, chat: chat(null) });
    expect(document.querySelector(".chat-timeout")).toBeNull();
  });

  /** The timeout bar runs down by itself, with no state pushed: full, half gone, then empty; gone once
   * touched, it asks for no more frames. */
  test("the timeout bar runs down with no state pushed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const page = await overlayPage();
      await page.show({ ...idle, chat: chat(Date.now() + config.chatTimeout) });
      const width = () => parseFloat(document.querySelector<HTMLElement>(".chat-timeout")?.style.width ?? "");

      expect(width()).toBeCloseTo(100, 0);
      vi.advanceTimersByTime(config.chatTimeout / 2);
      expect(width()).toBeCloseTo(50, 0);
      vi.advanceTimersByTime(config.chatTimeout);
      expect(width()).toBe(0);

      await page.show({ ...idle, chat: chat(null) });
      expect(document.querySelector(".chat-timeout")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A pointer entering or moving in the window, a click or a scroll keeps it open; once kept open
   * nothing more is sent. */
  test.each(["pointerover", "pointermove", "pointerdown", "wheel"])("a %s keeps it open", async (type) => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: chat(Date.now() + config.chatTimeout) });
    const box = document.querySelector(".chat-scroll");

    await act(async () => {
      box?.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(page.commands.filter((command) => command.type === "keepChatOpen")).toHaveLength(1);

    await page.show({ ...idle, chat: chat(null) });
    await act(async () => {
      box?.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(page.commands.filter((command) => command.type === "keepChatOpen")).toHaveLength(1);
  });

  /** While a tool the answer's model called runs, the window says what it is doing, under the request,
   * and nothing else about it shows. */
  test("it shows what a tool is doing while it runs", async () => {
    const page = await overlayPage();
    await page.show({ ...running, chat: chat(null) });
    expect(document.querySelector(".chat-activity")).toBeNull();

    await page.show({ ...running, chat: { ...chat(null), activity: "Checking your calendar" } });

    expect(document.querySelector(".chat-activity")?.textContent).toBe("Checking your calendar");
    expect(document.querySelector(".chat-activity .chat-spinner.spinning")).not.toBeNull();
    expect([...document.querySelectorAll(".chat-request")].at(-1)?.nextElementSibling?.className).toBe("chat-caption chat-activity");
    expect(document.querySelector(".chat-confirmation")).toBeNull();
  });

  /** A tool that sends or creates asks first: Cancel declines, Confirm runs it. */
  test.each([
    ["Cancel", ".chat-cancel", false],
    ["Confirm", ".chat-confirm", true],
  ])("its question's %s button answers it", async (title, selector, confirmed) => {
    const page = await overlayPage();
    await page.show({ ...running, chat: { ...chat(null), confirmation: "Add “Launch party” to your calendar on Friday at 18:00?" } });

    expect(document.querySelector(".chat-confirmation .chat-text")?.textContent).toBe("Add “Launch party” to your calendar on Friday at 18:00?");
    expect(texts(".chat-confirmation button")).toEqual(["Cancel", "Confirm"]);
    const button = document.querySelector<HTMLElement>(`.chat-confirmation ${selector}`);
    expect(button?.textContent).toBe(title);
    await act(async () => button?.click());

    expect(page.commands.filter((command) => command.type === "answerConfirmation")).toEqual([{ type: "answerConfirmation", confirmed }]);
  });

  /** A window a tool opened has no timeout yet, but is untouched: a touch there keeps it open once the
   * answer arrives. */
  test("a touch while a tool runs keeps it open", async () => {
    const page = await overlayPage();
    await page.show({ ...running, chat: { ...chat(null, false), activity: "Checking your calendar" } });

    await act(async () => {
      document.querySelector(".chat-scroll")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(page.commands.filter((command) => command.type === "keepChatOpen")).toHaveLength(1);
  });

  test("its close button closes it", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: chat(null) });

    await act(async () => document.querySelector<HTMLElement>(".chat-close")?.click());

    expect(page.commands).toContainEqual({ type: "closeChat" });
  });

  /** A reply's web link opens through the main process (which checks it again), never in the overlay
   * itself. */
  test("a link opens through the main process", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: chat(null) });
    const link = document.querySelector<HTMLAnchorElement>(".chat-text a");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    await act(async () => link?.dispatchEvent(click));

    expect(link?.textContent).toBe("the plan");
    expect(click.defaultPrevented).toBe(true);
    expect(page.commands).toContainEqual({ type: "openChatLink", url: "https://example.com/plan" });
  });

  /** The window reports its laid-out height, for the overlay to fit it. */
  test("it reports its height", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chat: chat(null) });

    expect(page.commands).toContainEqual({ type: "chatHeight", height: chatSize.height });
  });
});
