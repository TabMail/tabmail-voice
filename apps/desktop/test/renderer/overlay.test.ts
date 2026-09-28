// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
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

const listening: OverlayState = { phase: { kind: "listening" }, mode: "dictation", level: 0.5, isHearing: true, language: "en", tip: null, hotkey: "function", tools: [], emailAppIcon: null };

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
