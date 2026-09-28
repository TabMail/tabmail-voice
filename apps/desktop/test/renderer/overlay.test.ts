// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../src/core/config.js";
import type { DictationTip } from "../../src/core/tips.js";
import type { OverlayState } from "../../src/shared/ipc.js";

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

function laidOut(element: HTMLElement): { width: number; height: number } {
  if (element.classList.contains("pill-anchor")) return pillSize;
  if (element.querySelector(".tip") || element.classList.contains("tip")) return tipSize;
  return { width: 0, height: 0 };
}

const listening: OverlayState = { phase: { kind: "listening" }, mode: "dictation", level: 0.5, isHearing: true, language: "en", tip: null, opensUpward: false, hotkey: "function", tools: [], emailAppIcon: null };
const warmingUp: OverlayState = { ...listening, isHearing: false };
const idle: OverlayState = { ...listening, phase: { kind: "idle" } };

/** The overlay page, mounted afresh; `show` pushes it a state as the main process does. */
async function overlayPage(): Promise<{ show(state: OverlayState): Promise<void>; tipFrame(): { top: number; bottom: number } | null; pillFrame(): { top: number; bottom: number } }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  let listener: ((state: OverlayState) => void) | null = null;
  vi.stubGlobal("voice", {
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
    expect(document.querySelector(".tip-shape path")?.getAttribute("transform")?.includes("scale(1 -1)") ?? false).toBe(over);
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
