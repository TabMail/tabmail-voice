// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { alphabetical } from "../../src/core/agent/bubbleOrder.js";
import { connectorInfo } from "../../src/core/agent/connectors.js";
import { toolImplementations } from "../../src/core/agent/tools.js";
import * as config from "../../src/core/config.js";
import { brandColour } from "../../src/renderer/brand.js";
import type { DictationTip } from "../../src/core/tips.js";
import type { AgentChat } from "../../src/core/agent/agentChat.js";
import type { ChatPlacement, Command, OverlayState } from "../../src/shared/ipc.js";

/** Each React root the page creates, to unmount as the window closes. */
const mounted = vi.hoisted(() => ({ roots: [] as { unmount(): void }[] }));
// The question's time to answer, unlike the chat window's own timeout, so a bar timed by the wrong one shows.
vi.mock("../../src/core/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/core/config.js")>()), chatConfirmationTimeout: 20_000 }));
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
const chatSize = { width: 380, height: 146 };

function laidOut(element: HTMLElement): { width: number; height: number } {
  if (element.classList.contains("pill-anchor")) return pillSize;
  if (element.classList.contains("chat")) return chatSize;
  if (element.classList.contains("bubble-tooltip")) return tooltipLaidOut ? tooltipSize : { width: 0, height: 0 };
  if (element.querySelector(".tip") || element.classList.contains("tip")) return tipSize;
  return { width: 0, height: 0 };
}

const listening: OverlayState = { phase: { kind: "listening" }, mode: "dictation", level: 0.5, isHearing: true, language: "en", tip: null, opensUpward: false, bubblesFitUnder: true, hotkey: "function", tools: [], connectors: [], emailAppIcon: null, chat: null, recentBubbles: [], runningConnectors: [], chatPlacement: null };
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
  tooltipLaidOut = true;
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

  /** Agent mode draws a bubble for each tool and each app Answer reaches in one row, alphabetically
   * until one runs: under the pill with room there, the tip under them, and over it without. The first
   * few show in full, the next fade away to the right, and the rest don't show. While a tool runs the
   * others fade, as they would, and only it circles. */
  test.each([true, false])("a row of bubbles for the tools and apps, under the pill only when there is room (%s)", async (bubblesFitUnder) => {
    const page = await overlayPage();
    const tools: OverlayState["tools"] = ["compose", "thunderbird", "answer"];
    const apps: OverlayState["connectors"] = ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"];
    await page.show({ ...listening, mode: "agent", tools, connectors: apps, bubblesFitUnder, tip: "switchMode" });

    const showing = config.agentBubbleRowVisibleCount + config.agentBubbleRowFadeCount;
    const labels = () => [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => bubble.getAttribute("aria-label"));
    const opacities = () => [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => parseFloat(bubble.style.opacity));
    expect(labels()).toEqual(alphabetical([...tools, ...apps]).slice(0, showing));
    expect(labels()).toEqual(["answer", "calendar", "compose", "contacts"]);
    const lefts = [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => parseFloat((bubble.closest(".centred") as HTMLElement).style.left));
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(opacities().slice(0, config.agentBubbleRowVisibleCount)).toEqual([1, 1, 1]);
    expect(opacities().at(-1)).toBeGreaterThan(0);
    expect(opacities().at(-1)).toBeLessThan(1);
    const tops = [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => parseFloat((bubble.closest(".centred") as HTMLElement).style.top) - config.agentBubbleDiameter / 2);
    const pill = page.pillFrame();
    for (const top of tops) {
      if (bubblesFitUnder) expect(top).toBeGreaterThanOrEqual(pill.bottom);
      else expect(top + config.agentBubbleDiameter).toBeLessThanOrEqual(pill.top);
    }
    const tipFrame = page.tipFrame();
    if (bubblesFitUnder) for (const top of tops) expect(tipFrame?.top).toBeGreaterThanOrEqual(top + config.agentBubbleDiameter);

    // Compose running, having just been chosen: it moves to the front, circling, the rest fading.
    await page.show({ ...listening, phase: { kind: "running", tool: "compose" }, mode: "agent", tools, connectors: apps, bubblesFitUnder, recentBubbles: ["compose"] });
    expect(labels()).toEqual(["compose", "answer", "calendar", "contacts"]);
    expect(opacities()[0]).toBe(1);
    expect(opacities().slice(1, config.agentBubbleRowVisibleCount)).toEqual([config.agentBubbleIdleOpacity, config.agentBubbleIdleOpacity]);
    expect(document.querySelectorAll(".bubble .spinning")).toHaveLength(1);
    expect(document.querySelector('.bubble[aria-label="compose"] .spinning')).not.toBeNull();
  });

  /** The row is a history of the tools that ran, the latest on the left: Answer's apps as their tools
   * run too, each circling while it does, however many run at once. */
  test("the latest tools to run lead the row, and every running app circles", async () => {
    const page = await overlayPage();
    const state: OverlayState = { ...running, tools: ["compose", "answer"], connectors: ["calendar", "web", "notes"] };
    await page.show({ ...state, recentBubbles: ["web", "calendar", "answer", "notes"], runningConnectors: ["web", "calendar"] });

    const labels = [...document.querySelectorAll<HTMLElement>(".bubble")].map((bubble) => bubble.getAttribute("aria-label"));
    expect(labels).toEqual(["web", "calendar", "answer", "notes"]);
    const circling = [...document.querySelectorAll(".bubble")].filter((bubble) => bubble.querySelector(".spinning")).map((bubble) => bubble.getAttribute("aria-label"));
    expect(circling).toEqual(["web", "calendar", "answer"]);
    // Neither running app fades; the idle ones do.
    const opacity = (label: string) => parseFloat(document.querySelector<HTMLElement>(`.bubble[aria-label="${label}"]`)?.style.opacity ?? "");
    expect([opacity("web"), opacity("calendar"), opacity("notes")]).toEqual([1, 1, config.agentBubbleIdleOpacity * (1 - 1 / (config.agentBubbleRowFadeCount + 1))]);
  });

  /** In agent mode the pill glows as neon, a sign of the mode, in its own red-pink rather than the
   * brand's colours (owner, 2026-09-29), its bubbles not; working, a gradient arc circles its border
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
    expect(neon).toContain(`rgba(${config.agentPillGlowInnerColour.join(", ")}, ${config.agentPillGlowInnerOpacity})`);
    expect(neon).toContain(`rgba(${config.agentPillGlowOuterColour.join(", ")}, ${config.agentPillGlowOuterOpacity})`);
    // Not the brand's blue in its purple, as it was before.
    expect(neon).not.toContain(brandColour(0, config.agentPillGlowInnerOpacity));
    expect(neon).not.toContain(brandColour(1, config.agentPillGlowOuterOpacity));
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
    // Grown about its centre, where its `.centred` wrapper is placed.
    const grownTop = (label: string, scale: number) => parseFloat(bubble(label).closest<HTMLElement>(".centred")?.style.top ?? "") - (config.agentBubbleDiameter * scale) / 2;
    expect(tooltip()).toBeNull();

    await pointer("compose", "pointerover");
    expect([bubble("compose").style.transform, bubble("answer").style.transform]).toEqual([`scale(${config.agentBubbleHoverScale})`, "scale(1)"]);
    expect(said()).toEqual([toolImplementations.compose.displayName, toolImplementations.compose.settingsDescription]);
    expect(tooltip()?.style.visibility).toBe("visible");
    // Over the bubble as it has grown, clear of it.
    expect(tooltipBottom()).toBeCloseTo(grownTop("compose", config.agentBubbleHoverScale) - config.bubbleTooltipGap);
    expect(parseFloat(tooltip()?.style.left ?? "")).toBeCloseTo(parseFloat(bubble("compose").closest<HTMLElement>(".centred")?.style.left ?? ""));

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

    // Each bubble's tooltip over that bubble: centred on it, clear of it.
    const left = (label: string) => parseFloat(bubble(label).closest<HTMLElement>(".centred")?.style.left ?? "");
    await pointer("calendar", "pointerover");
    expect(said()).toEqual([connectorInfo.calendar.displayName, connectorInfo.calendar.settingsDescription]);
    expect(parseFloat(tooltip()?.style.left ?? "")).toBeCloseTo(left("calendar"));
    expect(tooltipBottom()).toBeCloseTo(grownTop("calendar", config.agentBubbleHoverScale) - config.bubbleTooltipGap);
    await page.show({ ...state, phase: { kind: "running", tool: "answer" } });
    expect([bubble("calendar").style.opacity, bubble("compose").style.opacity]).toEqual(["1", String(config.agentBubbleIdleOpacity)]);
    expect(said()[0]).toBe(connectorInfo.calendar.displayName);

    await pointer("calendar", "pointerout");
    await pointer("answer", "pointerover");
    expect(bubble("answer").style.transform).toBe(`scale(${config.agentBubbleRunningScale})`);
    expect(said()[0]).toBe(toolImplementations.answer.displayName);
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
    expect(next?.firstElementChild?.textContent).toBe(toolImplementations.answer.displayName);
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

  /** Under the chat window, with the pill off the window's centre, the row's last bubble is nearer the
   * window's edge than half the widest tooltip: its tooltip moves in to stay inside the window. */
  test("a tooltip under the chat window stays inside it", async () => {
    const page = await overlayPage();
    const tools: OverlayState["tools"] = ["compose", "answer"];
    const apps: OverlayState["connectors"] = ["calendar", "contacts", "email", "files"];
    const width = config.chatWidth + 2 * config.chatShadowMargin;
    await page.show({ ...idle, mode: "agent", tools, connectors: apps, chat: { turns: [], pendingRequest: null, closesAt: null, touched: true, activity: null, confirmation: null, confirmationExpiresAt: null }, chatPlacement: { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: width / 2 + 40 } });
    const bubble = [...document.querySelectorAll<HTMLElement>(".bubble")].at(-1) as HTMLElement;
    await act(async () => {
      bubble.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
    const centre = parseFloat(tooltip?.style.left ?? "");
    expect(centre + tooltipSize.width / 2).toBeLessThanOrEqual(width);
    expect(Math.abs(centre - parseFloat((bubble.closest(".centred") as HTMLElement).style.left))).toBeGreaterThan(1);
  });

  /** In dictation mode, and in agent mode before the tools are known, no app's bubble shows. */
  test("no app's bubble shows in dictation mode", async () => {
    const page = await overlayPage();
    await page.show({ ...listening, connectors: ["calendar", "web"] });

    expect(document.querySelectorAll(".bubble")).toHaveLength(0);
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
  /** Over the pill, its bubbles under it, the pill centred. */
  const above: ChatPlacement = { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: (config.chatWidth + 2 * config.chatShadowMargin) / 2 };
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
      confirmationExpiresAt: null,
    };
  }

  const texts = (selector: string) => [...document.querySelectorAll(selector)].map((element) => element.textContent);

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
    expect(document.querySelector<HTMLElement>(".chat-canvas .pill .centre-content")?.style.opacity).toBe(String(config.agentRestingSymbolOpacity));
    expect(document.querySelector(".swirl")).toBeNull();

    await page.show({ ...listening, chatPlacement: above, chat: chat(null) });
    expect(document.querySelector(".chat-canvas .pill .centre-content")).toBeNull();
    expect(document.querySelector(".chat-canvas .pill")).not.toBeNull();
  });

  /** The request as Thunderbird's chat shows one: a faint tint and hairline border, at most most of
   * the window's width. */
  test("a request shows as Thunderbird's chat shows one", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });

    const request = document.querySelector<HTMLElement>(".chat-request");
    expect(request?.style.maxWidth).toBe(`${config.chatWidth * config.chatRequestMaxWidthFraction}px`);
    expect(request?.style.borderRadius).toBe(`${config.chatBubbleCornerRadius}px`);
    expect(request?.style.border).toContain("solid");
  });

  /** A reply is revealed a line or list item at a time, `chatRevealStepInterval` apart, each fading in:
   * its paragraphs' lines, its lists' items (numbered from where the list starts) and its headings. */
  test("a reply is revealed a line or list item at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const page = await overlayPage();
      const reply = "Two options:\nboth this week\n\n3. Friday\n4. Saturday, after\n   the launch\n\n## Then\nShip it";
      const show = page.show({ ...idle, chatPlacement: above, chat: { ...chat(null), turns: [{ id: 0, request: "When", tool: "answer", reply }], pendingRequest: null } });
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
      const show = page.show({ ...idle, chatPlacement: above, chat: { ...chat(null), turns: [{ id: 0, request: "When", tool: "answer", reply: "One\nTwo\nThree\nFour" }], pendingRequest: null } });
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
    await page.show({ ...idle, chatPlacement: above, chat: { ...chat(null), turns: [{ id: 0, request: "What next", tool: "answer", reply }], pendingRequest: null } });

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
    // The last request's bubbles stay under the pill.
    expect(document.querySelectorAll(".chat-canvas .bubble")).toHaveLength(1);
  });

  /** A follow-up clears the tools until its screen read is done: meanwhile the last request's bubbles
   * stay under the pill, rather than vanishing and coming back. */
  test("a follow-up keeps the last request's bubbles until it has its own", async () => {
    const page = await overlayPage();
    const labels = () => [...document.querySelectorAll(".chat-canvas .bubble")].map((bubble) => bubble.getAttribute("aria-label"));
    await page.show({ ...idle, mode: "agent", tools: ["compose", "answer"], chat: chat(null), chatPlacement: above });
    expect(labels()).toEqual(["answer", "compose"]);

    await page.show({ ...warmingUp, mode: "agent", tools: [], chat: chat(null), chatPlacement: above });
    expect(labels()).toEqual(["answer", "compose"]);

    await page.show({ ...warmingUp, mode: "agent", tools: ["edit"], chat: chat(null), chatPlacement: above });
    expect(labels()).toEqual(["edit"]);
  });

  /** In the chat as out of it, the pill circles whenever the agent works (owner, 2026-09-28: "whenever
   * thinking is being done or whenever a tool is being run"): its rim spins while the words and the
   * tool are worked out, and while a tool runs, or waits on its question, a gradient arc circles it
   * around the agent's sparkle, as it circles the running tools' bubbles. At rest nothing circles. */
  test("the pill circles whenever the agent works, and so do the running tools' bubbles", async () => {
    const page = await overlayPage();
    const pillCircles = () => document.querySelector(".chat-canvas .pill .spinning") !== null;
    const circling = () => [...document.querySelectorAll(".chat-canvas .bubble")].filter((bubble) => bubble.querySelector(".spinning")).map((bubble) => bubble.getAttribute("aria-label"));
    const agent = { mode: "agent" as const, tools: ["answer" as const, "compose" as const], connectors: ["web" as const, "calendar" as const], chat: chat(null), chatPlacement: above };

    await page.show({ ...idle, ...agent });
    expect(pillCircles()).toBe(false);
    expect(circling()).toEqual([]);

    await page.show({ ...listening, ...agent, phase: { kind: "transcribing" } });
    expect(pillCircles()).toBe(true);
    expect(circling()).toEqual([]);

    await page.show({ ...running, ...agent });
    expect(pillCircles()).toBe(true);
    expect(document.querySelector(".chat-canvas .pill .centre-content")).not.toBeNull();
    expect(circling()).toEqual(["answer"]);

    await page.show({ ...running, ...agent, recentBubbles: ["web", "answer"], runningConnectors: ["web"] });
    expect(pillCircles()).toBe(true);
    expect(circling()).toEqual(["web", "answer"]);

    await page.show({ ...running, ...agent, runningConnectors: [], chat: { ...chat(null), confirmation: "Add “Launch party” to your calendar on Friday at 18:00?" } });
    expect(pillCircles()).toBe(true);

    await page.show({ ...idle, ...agent });
    expect(pillCircles()).toBe(false);
    expect(circling()).toEqual([]);
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
    await page.show({ ...idle, chatPlacement: above, chat: { ...longer, turns: [...longer.turns, { id: 2, request: "And the launch party", tool: "answer", reply: "Saturday" }], pendingRequest: null } });

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
      expect(bars()[0]?.parentElement?.className).toBe("chat-confirmation");
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

  /** The window reports its laid-out height, for the overlay to fit it. */
  test("it reports its height", async () => {
    const page = await overlayPage();
    await page.show({ ...idle, chatPlacement: above, chat: chat(null) });

    expect(page.commands).toContainEqual({ type: "chatHeight", height: chatSize.height });
  });
});
