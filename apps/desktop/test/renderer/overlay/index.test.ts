// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { alphabetical } from "../../../src/core/agent/bubbleOrder.js";
import type { EventQuestion } from "../../../src/core/agent/chat.js";
import { connectorByID } from "../../../src/core/agent/connectors/index.js";
import { agentTools } from "../../../src/core/agent/tools.js";
import * as config from "../../../src/core/config.js";
import { palette } from "../../../src/core/palette.js";
import { brandColor, rgba } from "../../../src/renderer/shared/brand.js";
import type { DictationTip } from "../../../src/core/onboarding/tips.js";
import { retryingMessage } from "../../../src/core/dictation/controller.js";
import type { AgentChat } from "../../../src/core/agent/chat.js";
import type { ChatPlacement, Command, OverlayState } from "../../../src/shared/ipc.js";

/** Each React root the page creates, to unmount as the window closes. */
const mounted = vi.hoisted(() => ({ roots: [] as { unmount(): void }[] }));
// The question's time to answer, unlike the chat window's own timeout, so a bar timed by the wrong one shows.
vi.mock("../../../src/core/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../../src/core/config.js")>()), chatConfirmationTimeout: 20_000 }));
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

/** Sizes as the page lays them out (happy-dom lays nothing out): the pill's, the tip's and a bubble's
 * tooltip's. */
const pillSize = { width: 180, height: 30 };
const tipSize = { width: 200, height: 73 };
const tooltipSize = { width: config.bubbleTooltipMaxWidth, height: 64 };
/** Whether the page has laid a tooltip out yet: until it has, it measures nothing. */
let tooltipLaidOut = true;
/** Whether the page has laid the tip by the pill out yet. */
let tipLaidOut = true;
/** The chat's scrolling column, as tall as what it shows (a test may grow it). */
const chatSize = { width: 380, height: 146 };

function laidOut(element: HTMLElement): { width: number; height: number } {
  if (element.classList.contains("pill-anchor")) return pillSize;
  if (element.classList.contains("chat-scroll")) return chatSize;
  if (element.classList.contains("bubble-tooltip")) return tooltipLaidOut ? tooltipSize : { width: 0, height: 0 };
  if (element.querySelector(".tip") || element.classList.contains("tip")) return tipLaidOut ? tipSize : { width: 0, height: 0 };
  return { width: 0, height: 0 };
}

const listening: OverlayState = { phase: { kind: "listening" }, mode: "dictation", level: 0.5, isHearing: true, hasVoice: true, isRetrying: false, language: "en", tip: null, opensUpward: false, bubblesFitUnder: true, hotkey: "function", tools: [], connectors: [], emailAppIcon: null, chat: null, recentBubbles: [], runningBubble: null, chatPlacement: null };
const warmingUp: OverlayState = { ...listening, isHearing: false };
/** The note for a text not pasted. */
const note = { kind: "notPasted", message: "Switched apps. Click to copy.", text: "Move the review to Friday." } as const;
const idle: OverlayState = { ...listening, phase: { kind: "idle" } };
const running: OverlayState = { ...listening, phase: { kind: "running", tool: "answer" }, mode: "agent", runningBubble: "answer" };

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
    await import("../../../src/renderer/overlay/index.js");
  });
  const frame = (element: Element | null, height: number) => {
    if (!(element instanceof HTMLElement)) return null;
    // `.centered` elements are placed by their center; `.pill-anchor` by its top.
    const top = parseFloat(element.style.top) - (element.classList.contains("centered") ? height / 2 : 0);
    return { top, bottom: top + height };
  };
  return {
    show: (state) =>
      act(async () => {
        listener?.(state);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
    tipFrame: () => frame(document.querySelector(".tip")?.closest(".centered") ?? null, tipSize.height),
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
  tooltipLaidOut = true;
  tipLaidOut = true;
  await unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("overlay page", () => {
  /** Each tip's box is as tall as its own lines (owner, 2026-09-30: the hands-free tip in two lines,
   * not three). */
  test.each<[DictationTip, number]>([
    ["handsFree", 2],
    ["agentAndHistory", 2],
    ["doubleTap", 3],
    ["agentMemory", 2],
  ])("the %s tip is %d lines, its box as tall", async (tip, count) => {
    const page = await overlayPage();
    await page.show({ ...listening, tip });
    expect(document.querySelectorAll(".tip-line")).toHaveLength(count);
    expect(document.querySelector<HTMLElement>(".tip-lines")?.style.height).toBe(`${config.tipBoxHeight(count)}px`);
  });

  /** A text not pasted (ADR-DESK-042) says so in the pill with a clipboard, not a failure's
   * exclamation mark, with a bar for the time left; a click on it copies the text. Replaced, it
   * takes no more clicks. */
  test("the not-pasted note shows its message by a clipboard, and the text it copies when clicked", async () => {
    const page = await overlayPage();
    const message = "Switched apps. Click to copy.";
    await page.show({ ...listening, phase: { ...note, message } });
    expect(document.querySelector(".pill .message")?.textContent).toBe(message);
    // The text itself, then a Copy link with its copy sign.
    expect(document.querySelector(".pill.note .note-text")?.textContent).toBe(note.text);
    expect(document.querySelector(".pill.note .note-copy")?.textContent).toBe("Copy");
    expect(document.querySelector(".pill.note .note-copy svg")).not.toBeNull();
    expect(document.querySelector(".pill.note .chat-timeout")).not.toBeNull();
    const clipboardIcon = document.querySelector(".pill svg")?.innerHTML;
    expect(clipboardIcon).toContain("rect");
    await act(async () => document.querySelector<HTMLElement>(".pill.note")?.click());
    expect(page.commands).toContainEqual({ type: "copyNotPasted" });

    await page.show({ ...listening, phase: { kind: "failed", message } });
    expect(document.querySelector(".pill.note")).toBeNull();
    expect(document.querySelector(".note-close")).toBeNull();
    expect(document.querySelector(".pill svg")?.innerHTML).not.toBe(clipboardIcon);
  });

  /** Anywhere on the note copies its text, the text, its Copy and its copy sign among them (owner,
   * 2026-10-09: "click on that word or the box or that icon to copy"). */
  test.each([".note-text", ".note-copy", ".note-copy svg", ".note-header .message"])("a click on the not-pasted note's %s copies it", async (part) => {
    const page = await overlayPage();
    await page.show({ ...listening, phase: note });

    await act(async () => document.querySelector(`.pill.note ${part}`)?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(page.commands.filter((command) => command.type === "copyNotPasted")).toHaveLength(1);
    expect(page.commands).not.toContainEqual({ type: "dismissNotPasted" });
  });

  /** However long its text, the note is no taller than `noteMaxHeight`, which its placement keeps on
   * screen, and holds the whole text, which a click copies. */
  test("the not-pasted note is no taller than its placement keeps room for", async () => {
    const page = await overlayPage();
    const long = `${"word ".repeat(400)}${"x".repeat(2_000)}\nand a last line`;
    await page.show({ ...listening, phase: { ...note, text: long } });

    const card = document.querySelector<HTMLElement>(".pill.note");
    expect(card?.style.maxHeight).toBe(`${config.noteMaxHeight}px`);
    expect(card?.style.overflow).toBe("hidden");
    const text = document.querySelector<HTMLElement>(".note-text");
    expect(text?.textContent).toBe(long);
  });

  /** Under the pointer, the note's Copy takes a wash of the accent, and gives it back when the pointer
   * leaves. */
  test("the not-pasted note's Copy lights up under the pointer", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, phase: note });
    const card = document.querySelector<HTMLElement>(".pill.note");
    const copy = () => document.querySelector<HTMLElement>(".pill.note .note-copy");
    const resting = copy()?.style.backgroundColor;
    expect(resting).toBe("transparent");

    await act(async () => card?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(copy()?.style.backgroundColor).toBe("var(--accent-wash)");

    await act(async () => card?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(copy()?.style.backgroundColor).toBe(resting);
    expect(page.commands).not.toContainEqual({ type: "copyNotPasted" });
  });

  /** The note's x dismisses it: the click is the x's alone, and copies nothing. */
  test("the not-pasted note's x dismisses it without copying", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, phase: note });
    const close = document.querySelector<HTMLElement>(".pill.note .note-close");
    expect(close?.getAttribute("aria-label")).toBe("Dismiss");

    await act(async () => close?.click());
    expect(page.commands).toContainEqual({ type: "dismissNotPasted" });
    expect(page.commands).not.toContainEqual({ type: "copyNotPasted" });
  });

  /** The note's bar runs down its ten seconds (the owner's ask, held here rather than read from the
   * config under test) by itself: full, half gone, then empty, copying nothing; gone with the note,
   * it asks for no more frames. */
  test("the not-pasted note's bar runs down its ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const page = await overlayPage();
      await page.show({ ...listening, phase: note });
      const width = () => parseFloat(document.querySelector<HTMLElement>(".pill.note .chat-timeout")?.style.width ?? "");

      expect(width()).toBeCloseTo(100, 0);
      vi.advanceTimersByTime(5_000);
      expect(width()).toBeCloseTo(50, 0);
      vi.advanceTimersByTime(5_000);
      expect(width()).toBe(0);
      expect(page.commands).not.toContainEqual({ type: "copyNotPasted" });

      await page.show({ ...listening, phase: { kind: "failed", message: "Couldn't copy. It's in the paste history." } });
      expect(document.querySelector(".chat-timeout")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The note takes clicks where the overlay lets them through only over it: each move of the
   * pointer says whether it is over the note, and leaving the window, it is not. Once the note is
   * gone, the pointer is no longer reported. */
  test("the not-pasted note says where the pointer is", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, phase: note });
    const pointers = () => page.commands.filter((command) => command.type === "pointerOver");
    const move = (target: Element | null) => target?.dispatchEvent(new Event("pointermove", { bubbles: true }));

    move(document.querySelector(".pill.note .message"));
    move(document.querySelector(".canvas"));
    move(document.querySelector(".pill.note"));
    document.documentElement.dispatchEvent(new Event("pointerleave"));
    expect(pointers()).toEqual([
      { type: "pointerOver", over: true },
      { type: "pointerOver", over: false },
      { type: "pointerOver", over: true },
      { type: "pointerOver", over: false },
    ]);

    await page.show({ ...listening, phase: { kind: "failed", message: "Couldn't copy. It's in the paste history." } });
    move(document.querySelector(".pill"));
    document.documentElement.dispatchEvent(new Event("pointerleave"));
    expect(pointers()).toHaveLength(4);
  });

  test.each([["en-US", "EN"], ["en", "EN"], ["zh-Hant-TW", "ZH"], ["pt-BR", "PT"], ["ko-KR", "KO"]])("language %s uses compact badge %s without losing its full accessible label", async (language, badge) => {
    const page = await overlayPage();
    await page.show({ ...listening, language });
    const element = document.querySelector(".badge");
    expect(element?.textContent).toBe(badge);
    expect(element?.getAttribute("aria-label")).toBe(new Intl.DisplayNames(undefined, { type: "language" }).of(language));
  });

  /** The hands-free tip, up the whole time it listens, goes over the pill in an overlay opened above
   * the caret's line, its arrow pointing down at the pill; opened below, it stays under the pill, and
   * a timed tip stays under it either way (owner, 2026-09-27: "above pill when opening up"). */
  test.each<[DictationTip, boolean, boolean]>([
    ["handsFree", true, true],
    ["handsFree", false, false],
    ["agentAndHistory", true, false],
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

    const bubbleTops = [...document.querySelectorAll(".bubble")].map((bubble) => parseFloat((bubble.closest(".centered") as HTMLElement).style.top) - config.agentBubbleDiameter / 2);
    // The two tools' and memory's.
    expect(bubbleTops).toHaveLength(3);
    const tipFrame = page.tipFrame();
    expect(tipFrame).not.toBeNull();
    for (const top of bubbleTops) expect(tipFrame?.bottom).toBeLessThanOrEqual(top);
  });

  /** Agent mode draws a bubble for each tool and each app Answer reaches in one row, alphabetically
   * until one runs: under the pill with room there, the tip under them, and over it without. The first
   * few show in full, the next fade away to the right, and the rest don't show. While a tool runs the
   * others fade, as they would, and only it circles. */
  test.each([true, false])("a row of bubbles for the tools and apps, under the pill only when there is room (%s)", async (bubblesFitUnder) => {
    const page = await overlayPage();
    const tools: OverlayState["tools"] = ["compose", "thunderbird", "answer"];
    const apps: OverlayState["connectors"] = ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"];
    await page.show({ ...listening, mode: "agent", tools, connectors: apps, bubblesFitUnder, tip: "agentAndHistory" });

    const showing = config.agentBubbleRowVisibleCount + config.agentBubbleRowFadeCount;
    const labels = () => [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => bubble.getAttribute("aria-label"));
    const opacities = () => [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => parseFloat(bubble.style.opacity));
    expect(labels()).toEqual(alphabetical([...tools, ...apps]).slice(0, showing));
    expect(labels()).toEqual(["answer", "calendar", "compose", "contacts"]);
    const lefts = [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => parseFloat((bubble.closest(".centered") as HTMLElement).style.left));
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(opacities().slice(0, config.agentBubbleRowVisibleCount)).toEqual([1, 1, 1]);
    expect(opacities().at(-1)).toBeGreaterThan(0);
    expect(opacities().at(-1)).toBeLessThan(1);
    const tops = [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => parseFloat((bubble.closest(".centered") as HTMLElement).style.top) - config.agentBubbleDiameter / 2);
    const pill = page.pillFrame();
    for (const top of tops) {
      if (bubblesFitUnder) expect(top).toBeGreaterThanOrEqual(pill.bottom);
      else expect(top + config.agentBubbleDiameter).toBeLessThanOrEqual(pill.top);
    }
    const tipFrame = page.tipFrame();
    if (bubblesFitUnder) for (const top of tops) expect(tipFrame?.top).toBeGreaterThanOrEqual(top + config.agentBubbleDiameter);

    // Compose running, having just been chosen: it moves to the front, circling, the rest fading.
    await page.show({ ...listening, phase: { kind: "running", tool: "compose" }, mode: "agent", tools, connectors: apps, bubblesFitUnder, recentBubbles: ["compose"], runningBubble: "compose" });
    expect(labels()).toEqual(["compose", "answer", "calendar", "contacts"]);
    expect(opacities()[0]).toBe(1);
    expect(opacities().slice(1, config.agentBubbleRowVisibleCount)).toEqual([config.agentBubbleIdleOpacity, config.agentBubbleIdleOpacity]);
    expect(document.querySelectorAll(".bubble .spinning")).toHaveLength(1);
    expect(document.querySelector('.bubble[aria-label="compose"] .spinning')).not.toBeNull();
  });

  /** The row is a history of the tools that ran, the latest on the left: Answer's apps as their tools
   * run too. Only the one running circles and is enlarged, the first in the row (owner, 2026-10-05:
   * "the only one that circles is the one on the far left, and the only one that's enlarged"); the
   * answer it runs for is small and faded meanwhile. */
  test("the latest tools to run lead the row, and only the running one circles, enlarged", async () => {
    const page = await overlayPage();
    const state: OverlayState = { ...running, tools: ["compose", "answer"], connectors: ["calendar", "web", "notes"] };
    await page.show({ ...state, recentBubbles: ["web", "calendar", "answer", "notes"], runningBubble: "web" });

    const labels = [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => bubble.getAttribute("aria-label"));
    expect(labels).toEqual(["web", "calendar", "answer", "notes"]);
    const circling = [...document.querySelectorAll(".bubble")].filter((bubble) => bubble.querySelector(".spinning")).map((bubble) => bubble.getAttribute("aria-label"));
    expect(circling).toEqual(["web"]);
    const scale = (label: string) => document.querySelector<HTMLElement>(`.bubble[aria-label="${label}"]`)?.style.transform;
    expect(scale("web")).toBe(`scale(${config.agentBubbleRunningScale})`);
    expect([scale("calendar"), scale("answer"), scale("notes")]).toEqual(["scale(1)", "scale(1)", "scale(1)"]);
    // The running app doesn't fade; the others, the answer included, do.
    const opacity = (label: string) => parseFloat(document.querySelector<HTMLElement>(`.bubble[aria-label="${label}"]`)?.style.opacity ?? "");
    expect([opacity("web"), opacity("calendar"), opacity("answer")]).toEqual([1, config.agentBubbleIdleOpacity, config.agentBubbleIdleOpacity]);
  });

  /** In agent mode the pill glows as neon, a sign of the mode, in its own red-pink rather than the
   * brand's colors (owner, 2026-09-29), its bubbles not; working, a gradient arc circles its border
   * (owner, 2026-09-28). Dictating, it has the plain glow and nothing circles. */
  test("the agent pill glows as neon, and circles while it works", async () => {
    const page = await overlayPage();
    const pill = () => document.querySelector<HTMLElement>(".pill");
    await page.show(listening);
    const plain = pill()?.style.boxShadow ?? "";
    expect(document.querySelector(".pill .spinning")).toBeNull();

    await page.show({ ...listening, mode: "agent", tools: ["compose"] });
    const neon = pill()?.style.boxShadow ?? "";
    expect(neon).not.toBe(plain);
    expect(neon).toContain(`${config.agentPillGlowOuterRadius}px`);
    expect(neon).toContain(rgba(palette.agentPillGlowInner, config.agentPillGlowInnerOpacity));
    expect(neon).toContain(rgba(palette.agentPillGlowOuter, config.agentPillGlowOuterOpacity));
    // Not the brand's blue in its purple, as it was before.
    expect(neon).not.toContain(brandColor(0, config.agentPillGlowInnerOpacity));
    expect(neon).not.toContain(brandColor(1, config.agentPillGlowOuterOpacity));
    expect(document.querySelector<HTMLElement>(".bubble")?.style.boxShadow).toBe(plain);
    expect(document.querySelector(".pill .spinning")).toBeNull();

    await page.show({ ...running, tools: ["answer"] });
    expect(document.querySelector(".pill .spinning")).not.toBeNull();
  });

  /** The Thunderbird bubble shows the email app's own icon once main has it, and its tool icon until
   * then; no other bubble shows it. */
  test("the Thunderbird bubble shows the email app's icon", async () => {
    const page = await overlayPage();
    const icon = "data:image/png;base64,AA==";
    const images = () => ["compose", "thunderbird"].map((label) => document.querySelector(`.bubble[aria-label="${label}"] img`)?.getAttribute("src") ?? null);
    const symbols = () => ["compose", "thunderbird"].map((label) => document.querySelector(`.bubble[aria-label="${label}"] svg`) !== null);

    await page.show({ ...listening, mode: "agent", tools: ["compose", "thunderbird"], emailAppIcon: icon });
    expect(images()).toEqual([null, icon]);
    expect(symbols()).toEqual([true, false]);

    await page.show({ ...listening, mode: "agent", tools: ["compose", "thunderbird"], emailAppIcon: null });
    expect(images()).toEqual([null, null]);
    expect(symbols()).toEqual([true, true]);
  });

  /** Memory's bubble shows with the tools' (its tools come with every request that offers one), with
   * Settings' memory icon, and circles at the front while its tools run, like an app's (owner,
   * 2026-10-19); none shows when no tool is offered. */
  test("memory has a bubble that circles while its tools run", async () => {
    const page = await overlayPage();
    const memory = () => document.querySelector<HTMLElement>('.bubble[aria-label="memory"]');
    const labels = () => [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => bubble.getAttribute("aria-label"));

    await page.show({ ...listening, mode: "agent", tools: ["compose", "answer"], connectors: ["web"] });
    expect(labels()).toEqual(["answer", "compose", "memory", "web"]);
    // Settings' memory icon: a clock with an arrow going back.
    expect(memory()?.querySelector("svg path")?.getAttribute("d")).toContain("M3.5 12a8.5 8.5 0 1 0");
    // In the bubbles' accent, as every other bubble (not Settings' plain clock).
    expect(memory()?.querySelector("svg")?.outerHTML).toContain("var(--accent)");
    expect(memory()?.querySelector(".spinning")).toBeNull();
    // Hovered, it says what it is.
    await act(async () => {
      memory()?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([...(document.querySelector('[role="tooltip"]')?.children ?? [])].map((line) => line.textContent)).toEqual([config.memoryBubbleName, config.memoryBubbleDescription]);

    await page.show({ ...running, tools: ["compose", "answer"], connectors: ["web"], recentBubbles: ["memory"], runningBubble: "memory" });
    expect(labels()[0]).toBe("memory");
    const circling = [...document.querySelectorAll(".bubble")].filter((bubble) => bubble.querySelector(".spinning")).map((bubble) => bubble.getAttribute("aria-label"));
    expect(circling).toEqual(["memory"]);

    await page.show({ ...listening, mode: "agent", tools: [] });
    expect(memory()).toBeNull();
  });

  /** A bubble under the pointer grows and says what it is: its name over its Settings description, a
   * tool's and an app's alike, in a tooltip clear over it. Faded while another tool runs, it shows in
   * full while hovered; the running tool's stays at its running size. The pointer leaving takes the
   * tooltip away (owner, 2026-09-28: "when mouse hovers over them, make them sort of enlarged and also
   * show tooltips on what this tool is"). */
  test("a hovered bubble grows and says what it is", async () => {
    const page = await overlayPage();
    const state: OverlayState = { ...listening, mode: "agent", tools: ["compose", "answer"], connectors: ["calendar"] };
    await page.show(state);
    const bubble = (label: string) => document.querySelector<HTMLElement>(`.bubble[aria-label="${label}"]`) as HTMLElement;
    const pointer = (label: string, type: "pointerover" | "pointerout") =>
      act(async () => {
        bubble(label).dispatchEvent(new PointerEvent(type, { bubbles: true, relatedTarget: null }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]');
    const said = () => [...(tooltip()?.children ?? [])].map((line) => line.textContent);
    // The tooltip's bottom, and the top of `label`'s bubble grown to `scale`, which it clears.
    const tooltipBottom = () => parseFloat(tooltip()?.style.top ?? "") + tooltipSize.height / 2;
    // Grown about its center, where its `.centered` wrapper is placed.
    const grownTop = (label: string, scale: number) => parseFloat(bubble(label).closest<HTMLElement>(".centered")?.style.top ?? "") - (config.agentBubbleDiameter * scale) / 2;
    expect(tooltip()).toBeNull();

    await pointer("compose", "pointerover");
    expect([bubble("compose").style.transform, bubble("answer").style.transform]).toEqual([`scale(${config.agentBubbleHoverScale})`, "scale(1)"]);
    expect(said()).toEqual([agentTools.compose.displayName, agentTools.compose.settingsDescription]);
    expect(tooltip()?.style.visibility).toBe("visible");
    // Over the bubble as it has grown, clear of it.
    expect(tooltipBottom()).toBeCloseTo(grownTop("compose", config.agentBubbleHoverScale) - config.bubbleTooltipGap);
    expect(parseFloat(tooltip()?.style.left ?? "")).toBeCloseTo(parseFloat(bubble("compose").closest<HTMLElement>(".centered")?.style.left ?? ""));

    await pointer("compose", "pointerout");
    expect(tooltip()).toBeNull();
    // Hidden until it is measured, so it never shows for a frame where it doesn't belong.
    tooltipLaidOut = false;
    await pointer("compose", "pointerover");
    expect(tooltip()?.style.visibility).toBe("hidden");
    tooltipLaidOut = true;
    await act(async () => {
      for (const observer of observers) observer.changed();
    });
    expect(tooltip()?.style.visibility).toBe("visible");
    await pointer("compose", "pointerout");
    expect(bubble("compose").style.transform).toBe("scale(1)");

    // Each bubble's tooltip over that bubble: centered on it, clear of it.
    const left = (label: string) => parseFloat(bubble(label).closest<HTMLElement>(".centered")?.style.left ?? "");
    await pointer("calendar", "pointerover");
    expect(said()).toEqual([connectorByID.calendar.displayName, connectorByID.calendar.settingsDescription]);
    expect(parseFloat(tooltip()?.style.left ?? "")).toBeCloseTo(left("calendar"));
    expect(tooltipBottom()).toBeCloseTo(grownTop("calendar", config.agentBubbleHoverScale) - config.bubbleTooltipGap);
    await page.show({ ...state, phase: { kind: "running", tool: "answer" }, runningBubble: "answer" });
    expect([bubble("calendar").style.opacity, bubble("compose").style.opacity]).toEqual(["1", String(config.agentBubbleIdleOpacity)]);
    expect(said()[0]).toBe(connectorByID.calendar.displayName);

    await pointer("calendar", "pointerout");
    await pointer("answer", "pointerover");
    expect(bubble("answer").style.transform).toBe(`scale(${config.agentBubbleRunningScale})`);
    expect(said()[0]).toBe(agentTools.answer.displayName);
    expect(tooltipBottom()).toBeCloseTo(grownTop("answer", config.agentBubbleRunningScale) - config.bubbleTooltipGap);
    expect(parseFloat(tooltip()?.style.left ?? "")).toBeCloseTo(left("answer"));
  });

  /** The pointer straight from one bubble onto the next: the next bubble's tooltip is its own, hidden
   * until measured, never the last one's showing the new words at the old size. */
  test("a tooltip for the next bubble is measured afresh", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, mode: "agent", tools: ["compose", "answer"] });
    const bubble = (label: string) => document.querySelector<HTMLElement>(`.bubble[aria-label="${label}"]`) as HTMLElement;
    await act(async () => {
      bubble("compose").dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const first = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(first?.style.visibility).toBe("visible");

    tooltipLaidOut = false;
    await act(async () => {
      bubble("compose").dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: bubble("answer") }));
      bubble("answer").dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: bubble("compose") }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const next = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(next?.firstElementChild?.textContent).toBe(agentTools.answer.displayName);
    expect(next === first).toBe(false);
    expect(next?.style.visibility).toBe("hidden");
  });

  /** Space back to dictation takes the bubbles away and their hover with them: back in agent mode, no
   * bubble is hovered until the pointer comes to one. */
  test("a bubble that goes and comes back is not hovered", async () => {
    const page = await overlayPage();
    const state: OverlayState = { ...listening, mode: "agent", tools: ["compose", "answer"] };
    await page.show(state);
    await act(async () => {
      document.querySelector('.bubble[aria-label="compose"]')?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

    await page.show({ ...state, mode: "dictation", tools: [] });
    await page.show(state);

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.querySelector<HTMLElement>('.bubble[aria-label="compose"]')?.style.transform).toBe("scale(1)");
  });

  /** Under the chat window, with the pill off the window's center, the row's last bubble is nearer the
   * window's edge than half the widest tooltip: its tooltip moves in to stay inside the window. */
  test("a tooltip under the chat window stays inside it", async () => {
    const page = await overlayPage();
    const tools: OverlayState["tools"] = ["compose", "answer"];
    const apps: OverlayState["connectors"] = ["calendar", "contacts", "email", "files"];
    const width = config.chatWidth + 2 * config.chatShadowMargin;
    await page.show({ ...idle, mode: "agent", tools, connectors: apps, chat: { turns: [], pendingRequest: null, questions: [], closesAt: null, touched: true, activity: null, confirmation: null, confirmationEvent: null, confirmationExpiresAt: null }, chatPlacement: { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: width / 2 + 40 } });
    const bubble = [...document.querySelectorAll<HTMLElement>(".bubble")].at(-1) as HTMLElement;
    await act(async () => {
      bubble.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
    const center = parseFloat(tooltip?.style.left ?? "");
    expect(center + tooltipSize.width / 2).toBeLessThanOrEqual(width);
    expect(Math.abs(center - parseFloat((bubble.closest(".centered") as HTMLElement).style.left))).toBeGreaterThan(1);
  });

  /** In dictation mode, and in agent mode before the tools are known, no app's bubble shows. */
  /** A transcription tried again after a server error says so in the pill, in place of the waveform
   * and without a failure's exclamation mark; agent mode's bubbles stay, as while it transcribes. */
  test.each(["dictation", "agent"] as const)("the retrying note shows in the pill in %s mode", async (mode) => {
    const page = await overlayPage();
    await page.show({ ...listening, mode, tools: ["compose"], phase: { kind: "retrying", message: retryingMessage } });

    expect(document.querySelector(".pill .message")?.textContent).toBe(retryingMessage);
    expect(document.querySelector(".pill svg")).toBeNull();
    // Compose's and memory's.
    expect(document.querySelectorAll(".bubble")).toHaveLength(mode === "agent" ? 2 : 0);
  });

  test("no app's bubble shows in dictation mode", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, connectors: ["calendar", "web"] });

    expect(document.querySelectorAll(".bubble")).toHaveLength(0);
  });

  /** The tip and its outline are placed and drawn by their size: until measured they are hidden, never
   * shown for a frame away from the pill or as words without their box (red-verified against each). */
  test("a tip is hidden until measured", async () => {
    const page = await overlayPage();
    tipLaidOut = false;
    await page.show({ ...listening, tip: "doubleTap" });
    const tip = () => document.querySelector<HTMLElement>(".tip");
    expect(tip()?.style.visibility).toBe("hidden");
    expect(tip()?.closest<HTMLElement>(".centered")?.style.visibility).toBe("hidden");
    tipLaidOut = true;
    await act(async () => {
      for (const observer of observers) observer.changed();
    });
    expect(tip()?.style.visibility).toBe("visible");
    expect(tip()?.closest<HTMLElement>(".centered")?.style.visibility).toBe("visible");
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
    const settle = () => new Promise((resolve) => setTimeout(resolve, config.pillSpringResponseSeconds * 1000 + 50));
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
    await act(() => new Promise((resolve) => setTimeout(resolve, config.pillSpringResponseSeconds * 1000 + 50)));

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
  /** Over the pill, its bubbles under it, the pill centered. */
  const above: ChatPlacement = { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: (config.chatWidth + 2 * config.chatShadowMargin) / 2 };
  /** An answer, then an Edit follow-up, with a third under way; untouched while it times out. */
  function chat(closesAt: number | null, touched = closesAt === null): AgentChat {
    return {
      turns: [
        { id: 0, request: "When do we ship", tool: "answer", reply: "We ship on **Friday**, see [the plan](https://example.com/plan)", questions: [] },
        { id: 1, request: "Say it shorter", tool: "edit", reply: "Friday", questions: [] },
      ],
      pendingRequest: "And the launch party",
      questions: [],
      closesAt,
      touched,
      activity: null,
      confirmation: null,
      confirmationEvent: null,
      confirmationExpiresAt: null,
    };
  }

  const texts = (selector: string) => [...document.querySelectorAll(selector)].map((element) => element.textContent);

  /** Owner, 2026-10-09: the chat window "should seem like it's growing out of the pill", and closing,
   * shrink, "sucked back into the agent pill": both about the pill's center, over it or under it;
   * the last chat stays drawn, shrinking, while the overlay keeps its place. */
  test("the chat window grows out of its pill and shrinks back into it as it closes", async () => {
    const page = await overlayPage();
    const moves: { keyframes: Keyframe[]; fill: unknown }[] = [];
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, keyframes, options) {
      if (this.classList.contains("chat")) moves.push({ keyframes: keyframes as Keyframe[], fill: (options as KeyframeAnimationOptions).fill });
      return { cancel: () => {} } as Animation;
    });
    try {
      const margin = config.chatShadowMargin;
      const atPill = { opacity: 0, transform: `scale(${config.chatPillScale})` };
      const full = { opacity: 1, transform: "none" };
      await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
      const box = document.querySelector<HTMLElement>(".chat");
      // Over the pill: its center under the chat's bottom edge, at the pill's x.
      expect(box?.style.transformOrigin).toBe(`${above.pillX - margin}px calc(100% + ${config.chatPillGap + config.pillHeight / 2}px)`);
      expect(moves).toEqual([{ keyframes: [atPill, full], fill: "backwards" }]);

      await page.show({ ...idle, chatPlacement: above, chat: null });
      expect(document.querySelector(".chat")).toBe(box);
      expect(texts(".chat-request")).toContain("Say it shorter");
      expect(moves.at(-1)).toEqual({ keyframes: [full, atPill], fill: "forwards" });

      await page.show({ ...idle, chatPlacement: null, chat: null });
      expect(document.querySelector(".chat")).toBeNull();

      // Under the pill and its bubbles: the pill's center over the chat's top edge.
      const below: ChatPlacement = { ...above, below: true };
      await page.show({ ...idle, chatPlacement: below, chat: chat(null) });
      expect(document.querySelector<HTMLElement>(".chat")?.style.transformOrigin).toBe(`${above.pillX - margin}px ${config.pillHeight / 2 - config.chatStripHeight - config.chatPillGap}px`);
    } finally {
      animate.mockRestore();
    }
  });

  /** A long message under the chat window wraps before the pill's glow reaches the window's edge,
   * where it was cut off (owner, 2026-10-06): the pill, centered in the window, is no wider than
   * the window less the glow on each side; and so is it with the chat window closed. */
  test("a long message's glow stays inside the window", async () => {
    const page = await overlayPage();
    const message = "The selection holds what looks like a password or key, so it wasn't rewritten.";
    const pillWidthLimit = () => parseFloat(document.querySelector<HTMLElement>(".pill")?.style.maxWidth ?? "");
    const glow = Math.max(config.pillGlowRadius, config.agentPillGlowOuterRadius);
    await page.show({ ...idle, phase: { kind: "failed", message }, mode: "agent", tools: ["answer"], chat: chat(null), chatPlacement: above });
    const window = config.chatWidth + 2 * config.chatShadowMargin;
    expect(pillWidthLimit()).toBeGreaterThan(0);
    expect(above.pillX - pillWidthLimit() / 2 - glow).toBeGreaterThanOrEqual(0);
    expect(above.pillX + pillWidthLimit() / 2 + glow).toBeLessThanOrEqual(window);

    await page.show({ ...listening, phase: { kind: "failed", message }, mode: "agent" });
    expect(pillWidthLimit() + 2 * glow).toBeLessThanOrEqual(config.overlayCanvasSize.width);
  });

  /** Each request and its reply, a request under way with the answer still thinking, and the pill
   * under them all, resting while nothing runs and listening for a follow-up; an Edit reply carries
   * its caption, the answer none. */
  test("it shows the conversation over the pill", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(Date.now() + config.chatTimeout) });

    expect(texts(".chat-request")).toEqual(["When do we ship", "Say it shorter", "And the launch party"]);
    expect(texts(".chat-text")).toEqual(["We ship on Friday, see the plan", "Friday"]);
    expect(texts(".chat-caption")).toEqual(["Replaced the selection", config.chatThinkingLabel]);
    expect(document.querySelector(".chat-text strong")?.textContent).toBe("Friday");
    // The pill, resting: a circle with a fainter sparkle.
    const pill = document.querySelector<HTMLElement>(".chat-canvas .pill");
    expect(pill).not.toBeNull();
    expect(document.querySelector<HTMLElement>(".chat-canvas .pill .center-content")?.style.opacity).toBe(String(config.agentRestingSymbolOpacity));
    expect(document.querySelector(".chat-canvas .pill .center-content svg")).not.toBeNull();
    expect(document.querySelector(".swirl")).toBeNull();

    await page.show({ ...listening, chatPlacement: above, chat: chat(null) });
    expect(document.querySelector(".chat-canvas .pill .center-content")).toBeNull();
    expect(document.querySelector(".chat-canvas .pill")).not.toBeNull();
  });

  /** The request as Thunderbird's chat shows one: one flat pale color (no gradient), the theme's in
   * light and dark, and a hairline border, at most most of the window's width. */
  test("a request shows as Thunderbird's chat shows one", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });

    const request = document.querySelector<HTMLElement>(".chat-request");
    expect(request?.style.maxWidth).toBe(`${config.chatWidth * config.chatRequestMaxWidthFraction}px`);
    expect(request?.style.borderRadius).toBe(`${config.chatBubbleCornerRadius}px`);
    expect(request?.style.background).toBe("var(--chat-request-fill)");
    expect(request?.style.borderWidth).toBe(`${config.pillBorderWidth}px`);
    expect(request?.style.borderColor).toBe("var(--chat-request-border)");
  });

  /** A reply is revealed a line or list item at a time, `chatRevealStepInterval` apart, each fading in:
   * its paragraphs' lines, its lists' items (numbered from where the list starts) and its headings. */
  test("a reply is revealed a line or list item at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const page = await overlayPage();
      const reply = "Two options:\nboth this week\n\n3. Friday\n4. Saturday, after\n   the launch\n\n## Then\nShip it";
      const show = page.show({ ...idle, chatPlacement: above, chat: { ...chat(null), turns: [{ id: 0, request: "When", tool: "answer", reply, questions: [] }], pendingRequest: null } });
      await vi.advanceTimersByTimeAsync(0);
      await show;
      const revealed = () => texts(".chat-text .reveal");
      // A step at a time, each revealed before the next is timed.
      const step = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(config.chatRevealStepInterval);
          });
        }
      };
      expect(revealed()).toEqual(["Two options:"]);

      await step(1);
      expect(revealed()).toEqual(["Two options:", "both this week"]);
      await step(4);
      expect(revealed()).toEqual(["Two options:", "both this week", "Friday", "Saturday, after\nthe launch", "Then", "Ship it"]);
      expect(document.querySelector(".chat-text ol")?.getAttribute("start")).toBe("3");
      expect(texts(".chat-text ol li")).toEqual(["Friday", "Saturday, after\nthe launch"]);
      expect(texts(".chat-heading")).toEqual(["Then"]);
      expect(document.querySelector<HTMLElement>(".chat-text .reveal")?.style.animationDuration).toBe(`${config.chatRevealFadeDuration}ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Each line a reply reveals keeps the newest in view, until the user scrolls up to read an earlier
   * answer: then the lines still to come leave the conversation where the user put it. */
  test("a revealed line keeps the newest in view unless the user scrolled up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const page = await overlayPage();
      const show = page.show({ ...idle, chatPlacement: above, chat: { ...chat(null), turns: [{ id: 0, request: "When", tool: "answer", reply: "One\nTwo\nThree\nFour", questions: [] }], pendingRequest: null } });
      await vi.advanceTimersByTimeAsync(0);
      await show;
      const scroll = document.querySelector<HTMLElement>(".chat-scroll");
      if (!scroll) throw new Error("no .chat-scroll");
      Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 200 });
      const step = () =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(config.chatRevealStepInterval);
        });

      scroll.scrollTop = 0;
      await step();
      expect(texts(".chat-text .reveal")).toEqual(["One", "Two"]);
      expect(scroll.scrollTop).toBe(500);

      scroll.scrollTop = 100;
      act(() => {
        scroll.dispatchEvent(new Event("scroll"));
      });
      await step();
      expect(texts(".chat-text .reveal")).toEqual(["One", "Two", "Three"]);
      expect(scroll.scrollTop).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A reply's inline Markdown shows as it reads: code, bold, italics, struck-out text and a link,
   * each around its own words and none of the text around them. */
  test("a reply's inline Markdown shows as it reads", async () => {
    const page = await overlayPage();
    const reply = "Run `npm test`, **now**, *please*, ~~not~~ [the plan](https://example.com/plan)";
    await page.show({ ...idle, chatPlacement: above, chat: { ...chat(null), turns: [{ id: 0, request: "What next", tool: "answer", reply, questions: [] }], pendingRequest: null } });

    expect(texts(".chat-text")).toEqual(["Run npm test, now, please, not the plan"]);
    expect(texts(".chat-text code")).toEqual(["npm test"]);
    expect(texts(".chat-text strong")).toEqual(["now"]);
    expect(texts(".chat-text em")).toEqual(["please"]);
    expect(texts(".chat-text s")).toEqual(["not"]);
    expect([...document.querySelectorAll(".chat-text a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["the plan", "https://example.com/plan"]]);
  });

  /** A follow-up warming up shows the pill, not the swirl: the pill under the chat window is where it
   * listens. */
  test("a follow-up warming up shows its pill", async () => {
    const page = await overlayPage();
    await page.show({ ...warmingUp, chatPlacement: above, chat: chat(null) });

    expect(document.querySelector(".chat-canvas .pill")).not.toBeNull();
    expect(document.querySelector(".swirl")).toBeNull();
  });

  /** Over the pill, the chat sits above the strip along the window's bottom edge the pill and its
   * bubbles take; under them, below the strip along its top edge. The pill is where the window says. */
  test.each<[string, ChatPlacement]>([
    ["over", above],
    ["under", { below: true, maxHeight: 200, bubblesUnder: true, pillX: 150 }],
  ])("it opens %s the pill, which stays where it was", async (_, chatPlacement) => {
    const page = await overlayPage();
    await page.show({ ...idle, mode: "agent", tools: ["compose"], chat: chat(null), chatPlacement });

    const offset = `${config.chatShadowMargin + config.chatStripHeight + config.chatPillGap}px`;
    const box = document.querySelector<HTMLElement>(".chat");
    const layer = document.querySelector<HTMLElement>(".chat-canvas .layer");
    expect(chatPlacement.below ? box?.style.top : box?.style.bottom).toBe(offset);
    expect(chatPlacement.below ? layer?.style.top : layer?.style.bottom).toBe("0px");
    expect(parseFloat(document.querySelector<HTMLElement>(".chat-canvas .pill-anchor")?.style.left ?? "")).toBe(chatPlacement.pillX);
    // It grows no taller than the screen leaves it room for there, then scrolls.
    expect(document.querySelector<HTMLElement>(".chat-scroll")?.style.maxHeight).toBe(`${chatPlacement.maxHeight}px`);
    // The last request's bubbles (Compose's and memory's) stay under the pill.
    expect(document.querySelectorAll(".chat-canvas .bubble")).toHaveLength(2);
  });

  /** A follow-up clears the tools until its screen read is done: meanwhile the last request's bubbles
   * stay under the pill, rather than vanishing and coming back. */
  test("a follow-up keeps the last request's bubbles until it has its own", async () => {
    const page = await overlayPage();
    const labels = () => [...document.querySelectorAll(".chat-canvas .bubble")].map((bubble) => bubble.getAttribute("aria-label"));
    await page.show({ ...idle, mode: "agent", tools: ["compose", "answer"], chat: chat(null), chatPlacement: above });
    expect(labels()).toEqual(["answer", "compose", "memory"]);

    await page.show({ ...warmingUp, mode: "agent", tools: [], chat: chat(null), chatPlacement: above });
    expect(labels()).toEqual(["answer", "compose", "memory"]);

    await page.show({ ...warmingUp, mode: "agent", tools: ["edit"], chat: chat(null), chatPlacement: above });
    expect(labels()).toEqual(["edit", "memory"]);
  });

  /** In the chat as out of it, the pill circles whenever the agent works (owner, 2026-09-28: "whenever
   * thinking is being done or whenever a tool is being run"): its rim spins while the words and the
   * tool are worked out, and while a tool runs, or waits on its question, a gradient arc circles it,
   * as it circles the running bubble. A working pill is an empty circle, with no icon (owner,
   * 2026-10-07); while the agent thinks no bubble circles. At rest nothing circles. */
  test("the pill circles whenever the agent works, and so does the running bubble", async () => {
    const page = await overlayPage();
    const pillCircles = () => document.querySelector(".chat-canvas .pill .spinning") !== null;
    const circling = () => [...document.querySelectorAll(".chat-canvas .bubble")].filter((bubble) => bubble.querySelector(".spinning")).map((bubble) => bubble.getAttribute("aria-label"));
    /** The working pill shows nothing in its circle: no icon, waveform or badge. */
    const pillEmpty = () => document.querySelector(".chat-canvas .pill :is(svg, .waveform, .badge)") === null;
    const agent = { mode: "agent" as const, tools: ["answer" as const, "compose" as const], connectors: ["web" as const, "calendar" as const], chat: chat(null), chatPlacement: above };

    await page.show({ ...idle, ...agent });
    expect(pillCircles()).toBe(false);
    expect(circling()).toEqual([]);

    await page.show({ ...listening, ...agent, phase: { kind: "transcribing" } });
    expect(pillCircles()).toBe(true);
    expect(pillEmpty()).toBe(true);
    expect(circling()).toEqual([]);

    await page.show({ ...running, ...agent, phase: { kind: "running", tool: null }, runningBubble: null });
    expect(pillCircles()).toBe(true);
    expect(pillEmpty()).toBe(true);
    expect(circling()).toEqual([]);

    await page.show({ ...running, ...agent });
    expect(pillCircles()).toBe(true);
    expect(pillEmpty()).toBe(true);
    expect(circling()).toEqual(["answer"]);

    await page.show({ ...running, ...agent, recentBubbles: ["web", "answer"], runningBubble: "web" });
    expect(pillCircles()).toBe(true);
    expect(circling()).toEqual(["web"]);

    await page.show({ ...running, ...agent, runningBubble: "answer", chat: { ...chat(null), confirmation: "Add “Launch party” to your calendar on Friday at 18:00?" } });
    expect(pillCircles()).toBe(true);

    await page.show({ ...idle, ...agent });
    expect(pillCircles()).toBe(false);
    expect(circling()).toEqual([]);
  });

  /** A circling rim's inner edge fades rather than stops: a hard edge is stair-stepped, and the steps
   * of the arc turning over the still track's showed as dots running around the ring (owner,
   * 2026-10-06). Every rim: the thinking circle's, the working pill's and the running bubble's. */
  test("a circling rim's inner edge is soft", async () => {
    const page = await overlayPage();
    const agent = { mode: "agent" as const, tools: ["answer" as const], chat: chat(null), chatPlacement: above };
    const innerEdges = () =>
      [...document.querySelectorAll<HTMLElement>(".rim")].map((rim) => {
        const stops = [...(rim.getAttribute("style") ?? "").matchAll(/calc\(100% - ([\d.]+)px\)/g)].map(([, length = ""]) => parseFloat(length));
        expect(stops).toHaveLength(2);
        return stops;
      });
    for (const phase of [{ kind: "transcribing" as const }, running.phase]) {
      await page.show({ ...listening, ...agent, phase });
      const edges = innerEdges();
      expect(edges.length).toBeGreaterThan(0);
      for (const [clear = 0, drawn = 0] of edges) expect(clear - drawn).toBeGreaterThanOrEqual(1);
    }
  });

  /** The waveform is a washed-out grey-blue until a voice is heard, then a vivid blue, a sign the dictation is
   * recording (owner, 2026-10-02); while a server error is tried again, the thinking circle's arc and track
   * show the retry's colors instead of the brand's (owner, 2026-10-03). Every color change eases over
   * `colorTransitionSeconds`. */
  test("the waveform takes its recording colour once a voice is heard, and the circle the retry's colours while a retry runs", async () => {
    const page = await overlayPage();
    // A color's red, green and blue, however the page writes it.
    const rgb = (css: string) => [...css.replace(/\s/g, "").matchAll(/(\d+),(\d+),(\d+)/g)].map((match) => match.slice(1, 4).join(","));
    const barColors = () => [...document.querySelectorAll<HTMLElement>(".pill .bar")].flatMap((bar) => rgb(bar.style.backgroundColor));
    const waiting = rgb(rgba(palette.waveformWaiting))[0] ?? "";
    const voiced = rgb(rgba(palette.waveformVoiced))[0] ?? "";
    const blue = rgb(brandColor(0))[0] ?? "";
    const arcEnd = rgb(brandColor(config.thinkingArcEndColor))[0] ?? "";
    const retryStart = rgb(rgba(palette.retryArcStart))[0] ?? "";
    const retryEnd = rgb(rgba(palette.retryArcEnd))[0] ?? "";
    // The bars ease into the new color rather than jump.
    const easing = () => [...document.querySelectorAll<HTMLElement>(".pill .bar")].map((bar) => bar.style.transition);
    // The thinking circle's layers of color: what each draws, whether it shows, and how it changes.
    const layers = () =>
      [...document.querySelectorAll<HTMLElement>(".pill .rim-layer")].map((layer) => ({
        colors: [...layer.querySelectorAll<HTMLElement>(".rim")].flatMap((rim) => rgb(rim.getAttribute("style") ?? "")),
        opacity: layer.style.opacity,
        transition: layer.style.transition,
      }));
    // What the eye sees: the colors of the layers showing.
    const shownColors = () => layers().flatMap((layer) => (layer.opacity === "0" ? [] : layer.colors));

    await page.show({ ...listening, hasVoice: false });
    expect(barColors()).toEqual(Array(config.overlayMeterBarCount).fill(waiting));
    expect(waiting).not.toBe(voiced);
    await page.show({ ...listening, hasVoice: true });
    expect(barColors()).toEqual(Array(config.overlayMeterBarCount).fill(voiced));
    expect(easing()).toHaveLength(config.overlayMeterBarCount);
    expect(easing().every((transition) => transition.includes(`background-color ${config.colorTransitionSeconds}s`))).toBe(true);

    const transcribing: OverlayState = { ...listening, phase: { kind: "transcribing" } };
    await page.show({ ...transcribing, isRetrying: false });
    expect(shownColors()).toEqual(expect.arrayContaining([blue, arcEnd]));
    expect(shownColors()).not.toContain(retryStart);
    expect(shownColors()).not.toContain(retryEnd);
    // Both sets of colors are drawn all along, so a retry fades in rather than jumps.
    expect(layers()).toHaveLength(2);
    expect(layers().every((layer) => layer.transition.includes(`opacity ${config.colorTransitionSeconds}s`))).toBe(true);

    await page.show({ ...transcribing, isRetrying: true });
    expect(shownColors()).toEqual(expect.arrayContaining([retryStart, retryEnd]));
    expect(shownColors()).not.toContain(blue);
    expect(shownColors()).not.toContain(arcEnd);
    expect(layers()).toHaveLength(2);

    // A retry that answers fades back.
    await page.show({ ...transcribing, isRetrying: false });
    expect(shownColors()).toEqual(expect.arrayContaining([blue, arcEnd]));
    expect(shownColors()).not.toContain(retryStart);
  });

  /** The overlay follows the system's light and dark (owner, 2026-10-09): the page takes both
   * themes, and the pill and the chat window are the theme's glass, with its rim and glow, never a
   * color of their own, so they turn dark with it. */
  test("the overlay follows light and dark, its surfaces the theme's glass", async () => {
    const page = await overlayPage();
    const colors = document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n");
    expect(colors).toContain(`--text: ${palette.light.text};`);
    expect(colors).toContain("prefers-color-scheme: dark");
    expect(colors).toContain(`--glass: ${palette.dark.glass};`);

    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    for (const surface of [".chat", ".pill"]) {
      const style = document.querySelector<HTMLElement>(surface)?.style;
      expect(style?.background, surface).toBe("var(--glass)");
      expect(style?.boxShadow, surface).toContain("var(--rim)");
    }
    // The crisp shadow, a Mac window's (owner, 2026-10-09), with room for it round the chat window.
    expect(document.querySelector<HTMLElement>(".chat")?.style.boxShadow).toContain("var(--contact)");
    expect(document.querySelector<HTMLElement>(".chat")?.style.boxShadow).toContain("var(--ambient)");
    expect(config.chatShadowMargin).toBeGreaterThanOrEqual(config.glassShadowReach);
    // The brand's glow on the chat; the pill beside it glows agent mode's red-pink.
    expect(document.querySelector<HTMLElement>(".chat")?.style.boxShadow).toContain("var(--glow)");
  });

  /** A new turn scrolls the conversation to it. */
  test("it scrolls to the newest turn", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: { ...chat(null), pendingRequest: null } });
    const scroll = document.querySelector<HTMLElement>(".chat-scroll");
    if (!scroll) throw new Error("no .chat-scroll");
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 500 });
    scroll.scrollTop = 0;

    const longer = chat(null);
    await page.show({ ...idle, chatPlacement: above, chat: { ...longer, turns: [...longer.turns, { id: 2, request: "And the launch party", tool: "answer", reply: "Saturday", questions: [] }], pendingRequest: null } });

    expect(scroll.scrollTop).toBe(500);
  });

  /** A state that shows nothing new in the window (a follow-up's level, its pill's phase, a new copy
   * of the same conversation, as each push brings) leaves the conversation where the user scrolled
   * it; its request joining scrolls to it. */
  test("an update that shows nothing new leaves the scroll where the user put it", async () => {
    const page = await overlayPage();
    const followUp: OverlayState = { ...listening, chatPlacement: above, mode: "agent", chat: { ...chat(null), pendingRequest: null } };
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
    expect(scroll.scrollTop).toBe(120);
    await page.show({ ...transcribing, chat: { ...chat(null), pendingRequest: "And the launch party" } });
    expect(scroll.scrollTop).toBe(500);

    // A tool's question, then its progress, joining a full window each scroll to it on its own, so its
    // buttons show; the same question pushed again doesn't.
    const loop: OverlayState = { ...running, chatPlacement: above, chat: { ...chat(null), pendingRequest: "And the launch party" } };
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
    await page.show({ ...idle, chatPlacement: above, chat: chat(Date.now() + config.chatTimeout / 2) });

    const bar = document.querySelector<HTMLElement>(".chat-timeout");
    expect(parseFloat(bar?.style.width ?? "")).toBeGreaterThan(40);
    expect(parseFloat(bar?.style.width ?? "")).toBeLessThanOrEqual(50);

    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    expect(document.querySelector(".chat-timeout")).toBeNull();
  });

  /** A level arrives about 12 times a second: the bars glide toward it every frame instead of stepping
   * to it, up over `waveformRiseSeconds` and down over the longer `waveformFallSeconds` (owner,
   * 2026-10-22: the waveform should move much more smoothly). */
  test("the waveform glides to each new level", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const page = await overlayPage();
      const center = () => parseFloat(document.querySelectorAll<HTMLElement>(".pill .bar")[(config.overlayMeterBarCount - 1) / 2]?.style.height ?? "");
      const span = config.overlayMeterMaxBarHeight - config.overlayMeterMinBarHeight;
      // The center bar at a level, its ripple anywhere in its range.
      const lowest = (level: number) => config.overlayMeterMinBarHeight + level * (1 - config.waveformRippleDepth) * span;
      const highest = (level: number) => config.overlayMeterMinBarHeight + Math.min(1, config.waveformIdleLevel + level) * span;
      const frame = 1_000 / 60;

      await page.show({ ...listening, level: 0 });
      vi.advanceTimersByTime(frame * 10);
      expect(center()).toBeLessThanOrEqual(highest(0));

      await page.show({ ...listening, level: 1 });
      vi.advanceTimersByTime(frame);
      expect(center()).toBeLessThan(highest(1 - Math.exp(-(2 * frame) / 1_000 / config.waveformRiseSeconds)));
      vi.advanceTimersByTime(config.waveformRiseSeconds * 1_000 * 5);
      expect(center()).toBeGreaterThan(lowest(0.95));

      await page.show({ ...listening, level: 0 });
      vi.advanceTimersByTime(frame);
      expect(center()).toBeGreaterThan(lowest(Math.exp(-(2 * frame) / 1_000 / config.waveformFallSeconds)));
      vi.advanceTimersByTime(config.waveformRiseSeconds * 1_000 * 5);
      // Still falling where a rise that long would be done: it settles more gently than it rises.
      expect(center()).toBeGreaterThan(lowest(Math.exp(-(config.waveformRiseSeconds * 5 + 2 * frame / 1_000) / config.waveformFallSeconds)));
      vi.advanceTimersByTime(config.waveformFallSeconds * 1_000 * 8);
      expect(center()).toBeLessThanOrEqual(highest(0.001));
    } finally {
      vi.useRealTimers();
    }
  });

  /** The bars' motion keeps time, not frames: at the same moment after a level arrives, a 25, 50 or
   * 125 Hz display shows the same bars, rising and falling. */
  test("the waveform moves the same at any frame rate", async () => {
    const heights = async (hz: number) => {
      const step = 1_000 / hz;
      let now = 0;
      let nextHandle = 1;
      const queued = new Map<number, FrameRequestCallback>();
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        queued.set(nextHandle, callback);
        return nextHandle++;
      });
      vi.stubGlobal("cancelAnimationFrame", (handle: number) => queued.delete(handle));
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const advance = (milliseconds: number) => {
        for (let frame = 0; frame < milliseconds / step; frame += 1) {
          now += step;
          const due = [...queued.values()];
          queued.clear();
          for (const callback of due) callback(now);
        }
      };
      const page = await overlayPage();
      const center = () => parseFloat(document.querySelectorAll<HTMLElement>(".pill .bar")[(config.overlayMeterBarCount - 1) / 2]?.style.height ?? "");
      await page.show({ ...listening, level: 0 });
      advance(200);
      await page.show({ ...listening, level: 1 });
      advance(200);
      const risen = center();
      await page.show({ ...listening, level: 0 });
      advance(200);
      const fallen = center();
      return { risen, fallen };
    };
    const [slow, usual, fast] = [await heights(25), await heights(50), await heights(125)];
    expect(usual.risen).toBeGreaterThan(usual.fallen);
    for (const other of [slow, fast]) {
      expect(other.risen).toBeCloseTo(usual.risen, 6);
      expect(other.fallen).toBeCloseTo(usual.fallen, 6);
    }
  });

  /** The timeout bar runs down by itself, with no state pushed: full, half gone, then empty; gone once
   * touched, it asks for no more frames. */
  test("the timeout bar runs down with no state pushed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const page = await overlayPage();
      await page.show({ ...idle, chatPlacement: above, chat: chat(Date.now() + config.chatTimeout) });
      const width = () => parseFloat(document.querySelector<HTMLElement>(".chat-timeout")?.style.width ?? "");

      expect(width()).toBeCloseTo(100, 0);
      vi.advanceTimersByTime(config.chatTimeout / 2);
      expect(width()).toBeCloseTo(50, 0);
      vi.advanceTimersByTime(config.chatTimeout);
      expect(width()).toBe(0);

      await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
      expect(document.querySelector(".chat-timeout")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A pointer event on the chat window, as a browser sends it: `buttons` held (the primary one,
   * unless said), its own pointer, at a point on the screen; `offsetX` where it is in its target. */
  function pointerOn(target: Element | null, type: string, x: number, y: number, options: { pointerType?: string; button?: number; buttons?: number; pointerId?: number; offsetX?: number } = {}) {
    const { pointerType = "mouse", button = 0, pointerId = 1 } = options;
    // `buttons` has the primary button at 1, the secondary at 2, the middle at 4.
    const buttons = options.buttons ?? (type === "pointerup" || type === "pointercancel" ? 0 : ([1, 4, 2][button] ?? 0));
    return act(async () => {
      const event = new PointerEvent(type, { bubbles: true, pointerId, pointerType, button, buttons, screenX: x, screenY: y });
      if (options.offsetX !== undefined) Object.defineProperty(event, "offsetX", { value: options.offsetX });
      target?.dispatchEvent(event);
    });
  }

  /** A mouse press on the chat that moves `chatDragThreshold` drags it (ADR-DESK-036 amendment): the
   * main process is told the drag started, then how far the pointer has gone on the screen since the
   * press, the chat window taking the pointer so the moves keep coming as it moves. A shorter move is
   * a click; once let go, moving drags nothing. */
  test("dragging the chat window tells how far it went", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    const drags = () => page.commands.filter((command) => command.type === "chatDragStart" || command.type === "dragChat");
    const captured: number[] = [];
    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(function (this: HTMLElement, id: number) {
      if (this.classList.contains("chat")) captured.push(id);
    });
    const text = document.querySelector(".chat-request");
    expect(text).not.toBeNull();

    await pointerOn(text, "pointerdown", 100, 100);
    await pointerOn(text, "pointermove", 102, 101);
    await pointerOn(text, "pointerup", 102, 101);
    expect(drags()).toEqual([]);
    expect(captured).toEqual([]);

    await pointerOn(text, "pointerdown", 100, 100);
    await pointerOn(text, "pointermove", 100 + config.chatDragThreshold, 100);
    expect(captured).toEqual([1]);
    await pointerOn(text, "pointermove", 160, 40);
    await pointerOn(text, "pointerup", 160, 40);
    await pointerOn(text, "pointermove", 200, 40, { buttons: 0 });
    expect(drags()).toEqual([
      { type: "chatDragStart" },
      { type: "dragChat", dx: config.chatDragThreshold, dy: 0 },
      { type: "dragChat", dx: 60, dy: -60 },
    ]);
  });

  /** Only the primary mouse button, on the chat's own surface, drags: not a press on its close button
   * or a link (which keep their click), on its scroll bar, with another button, or a touch (which
   * scrolls). A press on the scrolling list itself, off its scroll bar, still does. */
  test("only the primary button on the chat's surface drags it", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    const drags = () => page.commands.filter((command) => command.type === "chatDragStart" || command.type === "dragChat");
    const text = document.querySelector(".chat-request");
    const scroll = document.querySelector<HTMLElement>(".chat-scroll");
    const link = document.querySelector(".chat a");
    expect([text, scroll, link].every((element) => element !== null)).toBe(true);
    vi.spyOn(scroll as HTMLElement, "clientWidth", "get").mockReturnValue(300);
    const press = async (target: Element | null, options: Parameters<typeof pointerOn>[4] = {}) => {
      await pointerOn(target, "pointerdown", 100, 100, options);
      await pointerOn(target, "pointermove", 160, 160, options);
      await pointerOn(target, "pointerup", 160, 160, options);
    };

    await press(document.querySelector(".chat-close"));
    await press(link);
    await press(text, { pointerType: "touch" });
    await press(text, { button: 2 });
    await press(scroll, { offsetX: 305 });
    // A secondary press, then the primary button pressed with it: still not a drag.
    await pointerOn(text, "pointerdown", 100, 100, { button: 2 });
    await pointerOn(text, "pointermove", 160, 160, { button: 2, buttons: 3 });
    await pointerOn(text, "pointerup", 160, 160, { button: 2 });
    expect(drags()).toEqual([]);

    await press(scroll, { offsetX: 100 });
    expect(drags()).toEqual([{ type: "chatDragStart" }, { type: "dragChat", dx: 60, dy: 60 }]);
  });

  /** The press is the pointer's that made it, and ends with it: another pointer's moves drag nothing;
   * once cancelled, or its capture lost, moves drag nothing more; and let go outside the chat before
   * it dragged (the page never told), moving back over the chat with no button held is a hover. */
  test("a drag ends with its press", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    const drags = () => page.commands.filter((command) => command.type === "dragChat");
    const text = document.querySelector(".chat-request");
    const box = document.querySelector(".chat");

    await pointerOn(text, "pointerdown", 100, 100);
    await pointerOn(text, "pointermove", 160, 160, { pointerId: 2 });
    expect(drags()).toEqual([]);
    await pointerOn(text, "pointerup", 100, 100);

    await pointerOn(text, "pointerdown", 100, 100);
    await pointerOn(text, "pointermove", 102, 100);
    // Let go outside: no pointerup here. Back over the chat, no button held.
    await pointerOn(text, "pointermove", 120, 100, { buttons: 0 });
    await pointerOn(text, "pointermove", 140, 100, { buttons: 1 });
    expect(drags()).toEqual([]);

    for (const end of ["pointercancel", "lostpointercapture"]) {
      await pointerOn(text, "pointerdown", 100, 100);
      await pointerOn(text, "pointermove", 120, 100);
      const before = drags().length;
      await pointerOn(box, end, 120, 100);
      await pointerOn(text, "pointermove", 140, 100);
      expect(drags().length, end).toBe(before);
    }
  });

  /** A pointer entering or moving in the window, a click or a scroll keeps it open; once kept open
   * nothing more is sent. */
  test.each(["pointerover", "pointermove", "pointerdown", "wheel"])("a %s keeps it open", async (type) => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(Date.now() + config.chatTimeout) });
    const box = document.querySelector(".chat-scroll");

    await act(async () => {
      box?.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(page.commands.filter((command) => command.type === "keepChatOpen")).toHaveLength(1);

    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    await act(async () => {
      box?.dispatchEvent(new Event(type, { bubbles: true }));
    });
    expect(page.commands.filter((command) => command.type === "keepChatOpen")).toHaveLength(1);
  });

  /** While a tool the answer's model called runs, the window says what it is doing, under the request,
   * and nothing else about it shows. */
  test("it shows what a tool is doing while it runs", async () => {
    const page = await overlayPage();
    await page.show({ ...running, chatPlacement: above, chat: chat(null) });
    expect(document.querySelector(".chat-activity")?.textContent).toBe(config.chatThinkingLabel);
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), pendingRequest: null } });
    expect(document.querySelector(".chat-activity")).toBeNull();

    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), activity: "Checking your calendar" } });

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
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), confirmation: "Add “Launch party” to your calendar on Friday at 18:00?" } });

    expect(document.querySelector(".chat-confirmation .chat-text")?.textContent).toBe("Add “Launch party” to your calendar on Friday at 18:00?");
    expect(texts(".chat-confirmation button")).toEqual(["Cancel", "Confirm"]);
    const button = document.querySelector<HTMLElement>(`.chat-confirmation ${selector}`);
    expect(button?.textContent).toBe(title);
    await act(async () => button?.click());

    expect(page.commands.filter((command) => command.type === "answerConfirmation")).toEqual([{ type: "answerConfirmation", confirmed }]);
  });

  /** An answered question stays in its turn between the request and the reply, the user's words
   * under it when they answered aloud (owner, 2026-10-20): a label takes its buttons' place, so
   * nothing more answers it, saying what was done. */
  test.each([
    ["confirmed", null, "Yes, go ahead.", config.questionConfirmedLabels.question],
    ["confirmed", "add", "Yes, go ahead.", config.questionConfirmedLabels.add],
    ["confirmed", "change", "Yes, go ahead.", config.questionConfirmedLabels.change],
    ["confirmed", "delete", "Yes, go ahead.", config.questionConfirmedLabels.delete],
    ["declined", "add", "No, leave it.", config.questionDeclinedLabel],
    ["reading", null, "Yes.", config.questionReadingLabel],
  ] as const)("a question answered (%s, %s) stays in its turn, with what the user said", async (state, action, spoken, label) => {
    const page = await overlayPage();
    const answer = state === "reading" ? null : state;
    const event: EventQuestion | null = action === null ? null : { action, caption: "New event", month: "Oct", day: 21, weekday: "Wed", title: "Launch party", newTitle: null, time: "18:00 – 19:00", newTime: null, lines: [] };
    const turn = { id: 0, request: "Add the launch party", tool: "answer" as const, reply: "Done.", questions: [{ id: 1, text: "Add the launch party?", event, spoken, answer }] };
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), turns: [turn], pendingRequest: null } });

    const card = document.querySelector(".chat-confirmation");
    expect(card?.classList.contains("answered")).toBe(true);
    expect(card?.classList.contains(state)).toBe(true);
    expect(document.querySelectorAll(".chat-confirmation button")).toHaveLength(0);
    expect(card?.querySelector(".chat-question-status")?.textContent).toBe(label);
    // The button pressed stays, solid as it was: Confirm's blue (a delete's red) or Cancel's grey.
    const stays = card?.querySelector(".chat-question-status")?.className;
    expect(stays).toBe({ confirmed: action === "delete" ? "chat-question-status chat-confirm destructive" : "chat-question-status chat-confirm", declined: "chat-question-status chat-cancel", reading: "chat-question-status" }[state]);
    // While the model reads an answer aloud a small spinner shows; a screen reader hears the label.
    expect(card?.querySelectorAll(".chat-question-status .reading-spinner .spinning")).toHaveLength(state === "reading" ? 1 : 0);
    expect(seen(card?.querySelector(".chat-question-status") ?? null)).toBe(state === "reading" ? "" : label);
    // A tick for done, a cross for declined, nothing drawn beside the spinner.
    const glyphs = [...(card?.querySelectorAll(".chat-question-status > svg path") ?? [])].map((path) => path.getAttribute("d"));
    expect(glyphs).toEqual({ confirmed: ["M5 12.5 10 17.5 19 7"], declined: ["M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"], reading: [] }[state]);
    // The spinner is small: square, and no taller than the pill.
    const spinner = card?.querySelector<HTMLElement>(".reading-spinner");
    if (state === "reading") {
      const width = Number.parseFloat(spinner?.style.width ?? "0");
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(config.pillHeight);
      expect(spinner?.style.height).toBe(spinner?.style.width);
    }
    // Declined, the question and the button left fade; otherwise neither does.
    const faded = state === "declined";
    expect(card?.querySelector<HTMLElement>(".chat-question")?.style.opacity).toBe(String(faded ? config.chatQuestionDeclinedOpacity : 1));
    expect(card?.querySelector<HTMLElement>(".chat-question-status")?.style.opacity).toBe(String(faded ? config.chatQuestionDeclinedButtonOpacity : 1));
    // The request, the question, what the user said to it, then the reply.
    const order = [...document.querySelectorAll(".chat-turn .chat-request, .chat-turn .chat-text, .chat-turn .event-card")].map((element) => (element.classList.contains("event-card") ? "event" : element.textContent));
    const asked = event === null ? "Add the launch party?" : "event";
    expect(order.indexOf("Add the launch party")).toBeLessThan(order.indexOf(asked));
    expect(order.indexOf(asked)).toBeLessThan(order.indexOf(spoken));
    expect(order.indexOf(spoken)).toBeLessThan(order.indexOf("Done."));
  });

  /** Everything that spins turns at one speed, so none looks out of step with another (owner,
   * 2026-10-20): the thinking circle, a running bubble's border, the chat's activity spinner, and the
   * spinner on a question answered aloud. */
  test("every spinner turns at the one speed", async () => {
    const page = await overlayPage();
    const reading = { id: 1, text: "Add the launch party?", event: null, spoken: "Yes.", answer: null };
    const speeds = () => [...document.querySelectorAll<HTMLElement>(".spinning")].map((element) => element.style.animationDuration);
    const one = `${1 / config.spinnerRevolutionsPerSecond}s`;
    // A question answered aloud under a running bubble, the chat saying what a tool does.
    await page.show({ ...running, tools: ["answer"], connectors: ["calendar"], chatPlacement: above, chat: { ...chat(null), turns: [], pendingRequest: "Add the launch party", questions: [reading], activity: "Adding it to your calendar" } });
    expect(document.querySelectorAll(".reading-spinner .spinning")).toHaveLength(1);
    expect(document.querySelectorAll(".chat-spinner.spinning")).toHaveLength(1);
    const whileRunning = speeds();
    expect(whileRunning.length).toBeGreaterThanOrEqual(3);
    expect(new Set(whileRunning)).toEqual(new Set([one]));
    // The thinking circle, while transcribing.
    await page.show({ ...listening, phase: { kind: "transcribing" } });
    expect(document.querySelectorAll(".pill .rim-layer .spinning")).toHaveLength(2);
    expect(new Set(speeds())).toEqual(new Set([one]));
  });

  /** A question answered with a click has no words under it. */
  test("a question answered with a click shows no words of the user's under it", async () => {
    const page = await overlayPage();
    const turn = { id: 0, request: "Add the launch party", tool: "answer" as const, reply: "Done.", questions: [{ id: 1, text: "Add the launch party?", event: null, spoken: null, answer: "confirmed" as const }] };
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), turns: [turn], pendingRequest: null } });

    expect(texts(".chat-turn .chat-request, .chat-turn .chat-text")).toEqual(["Add the launch party", "Add the launch party?", "Done."]);
  });

  /** The questions a request asked and was answered show in the order answered, each with the
   * user's words: under the request while it is still carried out, with the question it asks now
   * under them, and in its turn once done. */
  test.each(["still carried out", "done"] as const)("a request's answered questions keep their order (%s)", async (where) => {
    const page = await overlayPage();
    const questions = [
      { id: 1, text: "Add the first event?", event: null, spoken: "Yes, the first.", answer: "confirmed" as const },
      { id: 2, text: "Add the second event?", event: null, spoken: "No, leave the second.", answer: "declined" as const },
    ];
    const pending = where === "still carried out";
    const turn = { id: 0, request: "Add two events", tool: "answer" as const, reply: "Done.", questions };
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), turns: pending ? [] : [turn], pendingRequest: pending ? "Add two events" : null, questions: pending ? questions : [], confirmation: pending ? "Add the third event?" : null, confirmationExpiresAt: pending ? Date.now() + config.chatConfirmationTimeout : null } });

    const order = [...document.querySelectorAll(".chat-scroll .chat-request, .chat-scroll .chat-text")].map((element) => `${element.closest(".chat-confirmation:not(.answered)") ? "asking: " : ""}${element.textContent}`);
    expect(order).toEqual(["Add two events", "Add the first event?", "Yes, the first.", "Add the second event?", "No, leave the second.", pending ? "asking: Add the third event?" : "Done."]);
  });

  /** A question answered scrolls the chat to the bottom, even when the next it asks has the same
   * words, so the question asked now stays in view; nothing new keeps the place the user scrolled to. */
  test("an answered question scrolls the chat to its end", async () => {
    const page = await overlayPage();
    const asking = { ...chat(null), turns: [], pendingRequest: "Add the launch party", questions: [], confirmation: "Add it?", confirmationExpiresAt: null };
    const state = { ...running, chatPlacement: above, chat: asking };
    await page.show(state);
    const scroll = document.querySelector<HTMLElement>(".chat-scroll");
    if (scroll === null) throw new Error("no chat");
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 200 });
    scroll.scrollTop = 120;
    scroll.dispatchEvent(new Event("scroll"));

    await page.show({ ...state, level: 0.1, chat: structuredClone(asking) });
    expect(scroll.scrollTop).toBe(120);
    await page.show({ ...state, chat: { ...asking, questions: [{ id: 1, text: "Add it?", event: null, spoken: "No.", answer: "declined" as const }] } });
    expect(texts(".chat-request")).toEqual(["Add the launch party", "No."]);
    expect(scroll.scrollTop).toBe(500);
  });

  /** What `element` shows on screen: its text without the words only a screen reader hears. */
  const seen = (element: Element | null) => {
    const copy = element?.cloneNode(true) as Element | undefined;
    copy?.querySelectorAll(".sr-only").forEach((hidden) => hidden.remove());
    return copy?.textContent ?? null;
  };
  /** What a screen reader hears of `element`: its text without what the accessibility tree leaves
   * out, an `aria-hidden` element or one the overlay's stylesheet hides (`display: none`,
   * `visibility: hidden`), so the words only a screen reader hears must stay in the tree. */
  const heard = (element: Element | null) => {
    if (element === null) return null;
    const style = document.createElement("style");
    style.textContent = readFileSync(join(import.meta.dirname, "../../../src/renderer/overlay/index.css"), "utf8");
    document.head.append(style);
    const spoken = (node: Node): string => {
      if (!(node instanceof Element)) return node.textContent ?? "";
      const computed = getComputedStyle(node);
      if (node.getAttribute("aria-hidden") === "true" || computed.display === "none" || computed.visibility === "hidden") return "";
      return [...node.childNodes].map(spoken).join("");
    };
    try {
      return spoken(element);
    } finally {
      style.remove();
    }
  };

  /** A question about a calendar event draws the event, not its words: the page for its day, its
   * title and time (the old struck out by the new), each line with its icon and tone, the people it
   * invites and removes each a list under one icon, each person as "name <address>", and a button
   * that says what confirming does, red for a delete. A screen reader hears what the strike-out, the
   * accent and the icons show: "Title changes from … to …", "Invited: …", "Removed location: …",
   * "New: Every day". */
  test.each<[EventQuestion["action"], string, boolean]>([
    ["add", "Add", false],
    ["change", "Save", false],
    ["delete", "Delete", true],
  ])("a %s question's event is drawn, and its button answers it", async (action, title, destructive) => {
    const event: EventQuestion = {
      action,
      caption: "Change this occurrence",
      month: "Oct",
      day: 22,
      weekday: "Thu",
      title: "Team sync",
      newTitle: "Kickoff",
      time: "10:00 – 10:30 AM",
      newTime: "3:00 – 3:30 PM",
      lines: [
        { icon: "person", text: "Pat Doe", detail: "pat@example.com", tone: "added" },
        { icon: "person", text: "jordan@example.com", detail: null, tone: "added" },
        { icon: "person", text: "alex@example.com", detail: null, tone: "removed" },
        { icon: "person", text: "chris@example.com", detail: null, tone: "removed" },
        { icon: "mail", text: "Invitations are emailed.", detail: null, tone: "note" },
        { icon: "location", text: "Room 5", detail: null, tone: "plain" },
        { icon: "location", text: "Room 4", detail: null, tone: "removed" },
        { icon: "notes", text: "Bring the deck", detail: null, tone: "added" },
        { icon: "availability", text: "Shown as free", detail: null, tone: "added" },
        { icon: "repeat", text: "Every day, 3 times", detail: null, tone: "added" },
      ],
    };
    const page = await overlayPage();
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), confirmation: "Change this event?", confirmationEvent: event } });

    expect(document.querySelector(".chat-confirmation .chat-text")).toBeNull();
    expect(document.querySelector(".event-card .chat-caption")?.textContent).toBe("Change this occurrence");
    expect(document.querySelector(".event-card .chat-caption")?.classList.contains("event-deleting")).toBe(destructive);
    expect(texts(".event-page [aria-hidden='true']")).toEqual(["OCT", "22", "Thu"]);
    expect(seen(document.querySelector(".event-page"))).toBe("OCT22Thu");
    expect(heard(document.querySelector(".event-page"))).toBe("Thu, Oct 22");
    expect(document.querySelector(".event-page")?.classList.contains("event-deleting")).toBe(destructive);
    expect(seen(document.querySelector(".event-title"))).toBe("Team sync Kickoff");
    expect(texts(".event-title del.event-removed")).toEqual(["Team sync"]);
    expect(texts(".event-title ins.event-added")).toEqual(["Kickoff"]);
    expect(heard(document.querySelector(".event-title"))).toBe("Title changes from Team sync to Kickoff");
    expect(texts(".event-time del.event-removed")).toEqual(["10:00 – 10:30 AM"]);
    expect(texts(".event-time ins.event-added")).toEqual(["3:00 – 3:30 PM"]);
    expect(heard(document.querySelector(".event-time"))).toBe("Time changes from 10:00 – 10:30 AM to 3:00 – 3:30 PM");
    const lines = [...document.querySelectorAll(".event-line")];
    expect(lines.map((line) => line.className)).toEqual(["event-line event-people added", "event-line event-people removed", "event-line note", "event-line plain", "event-line removed", "event-line added", "event-line added", "event-line added"]);
    expect(lines.map((line) => line.querySelectorAll("svg").length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(texts(".event-people-label")).toEqual(["Invite", "Remove"]);
    // The label is for the eye; each person is heard as invited or removed instead.
    expect([...document.querySelectorAll(".event-people")].map(heard)).toEqual(["Invited: Pat Doe, pat@example.comInvited: jordan@example.com", "Removed: alex@example.comRemoved: chris@example.com"]);
    const words = [...document.querySelectorAll(".event-line-text")];
    expect(words.map(seen)).toEqual(["Pat Doe <pat@example.com>", "jordan@example.com", "alex@example.com", "chris@example.com", "Invitations are emailed.", "Room 5", "Room 4", "Bring the deck", "Shown as free", "Every day, 3 times"]);
    expect(words.map(heard)).toEqual(["Invited: Pat Doe, pat@example.com", "Invited: jordan@example.com", "Removed: alex@example.com", "Removed: chris@example.com", "Invitations are emailed.", "Location: Room 5", "Removed location: Room 4", "New notes: Bring the deck", "New: Shown as free", "New: Every day, 3 times"]);
    expect(words.map((word) => word.tagName)).toEqual(["SPAN", "SPAN", "DEL", "DEL", "SPAN", "SPAN", "DEL", "SPAN", "SPAN", "SPAN"]);
    expect(texts(".chat-confirmation button")).toEqual(["Cancel", title]);
    const button = document.querySelector<HTMLElement>(".chat-confirmation .chat-confirm");
    expect(button?.classList.contains("destructive")).toBe(destructive);
    // The class alone colours it: red for a delete, the brand blue otherwise, nothing inline to beat it.
    expect(button?.style.background).toBe("");
    await act(async () => button?.click());

    expect(page.commands.filter((command) => command.type === "answerConfirmation")).toEqual([{ type: "answerConfirmation", confirmed: true }]);
  });

  /** A new event's people are invited: one list under Invite, each heard as invited; a calendar line
   * names its field, and an occurrence dropped is heard as removed. */
  test("a new event's people are one list under Invite", async () => {
    const page = await overlayPage();
    const event: EventQuestion = {
      action: "add",
      caption: "New event",
      month: "Oct",
      day: 21,
      weekday: "Wed",
      title: "Design review",
      newTitle: null,
      time: "10:00 – 11:00 AM",
      newTime: null,
      lines: [
        { icon: "calendar", text: "Work", detail: "iCloud", tone: "plain" },
        { icon: "person", text: "Alex Kim", detail: "alex@example.com", tone: "plain" },
        { icon: "person", text: "sam@example.com", detail: null, tone: "plain" },
        { icon: "deleted", text: "Thu, Oct 29", detail: null, tone: "removed" },
      ],
    };
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), confirmation: "Add this event?", confirmationEvent: event } });

    expect([...document.querySelectorAll(".event-line")].map((line) => line.className)).toEqual(["event-line plain", "event-line event-people plain", "event-line removed"]);
    expect(texts(".event-people-label")).toEqual(["Invite"]);
    expect([...document.querySelectorAll(".event-line-text")].map(heard)).toEqual(["Calendar: Work iCloud", "Invited: Alex Kim, alex@example.com", "Invited: sam@example.com", "Removed occurrence: Thu, Oct 29"]);
    expect(heard(document.querySelector(".event-title"))).toBe("Design review");
  });

  /** An event with nothing new to say draws its title and time alone, with no lines. */
  test("an event question with no lines draws only its page, title and time", async () => {
    const page = await overlayPage();
    const event: EventQuestion = { action: "add", caption: "New event", month: "Oct", day: 21, weekday: "Wed", title: "Focus", newTitle: null, time: "All day", newTime: null, lines: [] };
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), confirmation: "Add this event to your calendar?", confirmationEvent: event } });

    expect(document.querySelector(".event-title")?.textContent).toBe("Focus");
    expect(document.querySelector(".event-time")?.textContent).toBe("All day");
    expect(document.querySelector(".event-lines")).toBeNull();
    expect(document.querySelector(".event-removed")).toBeNull();
  });

  /** A question shows the time left to answer it as a bar along its own bottom edge, running down with
   * no state pushed; without a time, none. */
  test("its question's time to answer runs down under it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const page = await overlayPage();
      const question = "Add “Launch party” to your calendar on Friday at 18:00?";
      await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), confirmation: question, confirmationExpiresAt: Date.now() + config.chatConfirmationTimeout } });
      const bars = () => [...document.querySelectorAll<HTMLElement>(".chat-timeout")];
      const width = () => parseFloat(bars()[0]?.style.width ?? "");

      expect(bars()).toHaveLength(1);
      expect(bars()[0]?.closest(".chat-timeout-track")?.parentElement?.className).toBe("chat-confirmation");
      expect(width()).toBeCloseTo(100, 0);
      vi.advanceTimersByTime(config.chatConfirmationTimeout / 2);
      expect(width()).toBeCloseTo(50, 0);
      vi.advanceTimersByTime(config.chatConfirmationTimeout);
      expect(width()).toBe(0);

      await page.show({ ...running, chatPlacement: above, chat: { ...chat(null), confirmation: question } });
      expect(bars()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A window a tool opened has no timeout yet, but is untouched: a touch there keeps it open once the
   * answer arrives. */
  test("a touch while a tool runs keeps it open", async () => {
    const page = await overlayPage();
    await page.show({ ...running, chatPlacement: above, chat: { ...chat(null, false), activity: "Checking your calendar" } });

    await act(async () => {
      document.querySelector(".chat-scroll")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(page.commands.filter((command) => command.type === "keepChatOpen")).toHaveLength(1);
  });

  test("its close button closes it", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });

    await act(async () => document.querySelector<HTMLElement>(".chat-close")?.click());

    expect(page.commands).toContainEqual({ type: "closeChat" });
  });

  /** A reply's web link opens through the main process (which checks it again), never in the overlay
   * itself. */
  test("a link opens through the main process", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    const link = document.querySelector<HTMLAnchorElement>(".chat-text a");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    await act(async () => link?.dispatchEvent(click));

    expect(link?.textContent).toBe("the plan");
    expect(click.defaultPrevented).toBe(true);
    expect(page.commands).toContainEqual({ type: "openChatLink", url: "https://example.com/plan" });
  });

  /** The window is as tall as what it shows, with its border, and says so: only that much of the
   * overlay takes clicks. As a reply's next line shows, it grows to it smoothly, in the overlay at
   * its tallest, rather than the overlay resizing (owner, 2026-10-04: "super clunky"). */
  test("it grows smoothly to what it shows, and reports its height", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });
    const box = document.querySelector<HTMLElement>(".chat");
    const height = chatSize.height + 2 * config.pillBorderWidth;
    expect(box?.style.height).toBe(`${height}px`);
    expect(box?.style.transition).toBe(`height ${config.chatGrowDurationSeconds}s ease-out`);
    expect(page.commands).toContainEqual({ type: "chatHeight", height });

    const grown = chatSize.height + 40;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("chat-scroll") ? grown : laidOut(this).height;
    });
    await act(async () => {
      for (const observer of observers) observer.changed();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(box?.style.height).toBe(`${grown + 2 * config.pillBorderWidth}px`);
    expect(page.commands.filter((command) => command.type === "chatHeight")).toEqual([
      { type: "chatHeight", height },
      { type: "chatHeight", height: grown + 2 * config.pillBorderWidth },
    ]);
  });

  /** Each move of the pointer says whether it is over the chat or the pill's bubbles, for the overlay
   * to take clicks only there (`ChatHitTest`); leaving the window, it is over neither. */
  test("it says where the pointer is", async () => {
    const page = await overlayPage();
    await page.show({ ...running, chatPlacement: above, chat: chat(null), tools: ["compose", "answer"] });
    const pointers = () => page.commands.filter((command) => command.type === "pointerOver");
    const move = (target: Element | null) => target?.dispatchEvent(new Event("pointermove", { bubbles: true }));

    move(document.querySelector(".chat-text"));
    move(document.querySelector(".chat-canvas"));
    move(document.querySelector(".chat-canvas .bubble"));
    document.documentElement.dispatchEvent(new Event("pointerleave"));
    expect(pointers()).toEqual([
      { type: "pointerOver", over: true },
      { type: "pointerOver", over: false },
      { type: "pointerOver", over: true },
      { type: "pointerOver", over: false },
    ]);

    await page.show({ ...idle, chatPlacement: null, chat: null });
    move(document.querySelector(".canvas"));
    expect(pointers()).toHaveLength(4);
  });
});
