import { describe, expect, it } from "vitest";
import { shellFreeAreas } from "../../../../src/main/native/windows/overlayArea.js";
const screen = { x: 0, y: 0, width: 1500, height: 900 };
describe("shell exclusion areas", () => {
  it("leaves ordinary placement unchanged", () => {
    expect(shellFreeAreas(screen, [], 8)).toEqual([screen]);
    expect(shellFreeAreas(screen, [{ x: -1200, y: 10, width: 900, height: 800 }], 8)).toEqual([screen]);
  });
  it("retains full strips around expanded Search bounds", () => {
    expect(shellFreeAreas(screen, [{ x: 350, y: 150, width: 800, height: 750 }], 8)).toEqual([
      { x: 0, y: 0, width: 342, height: 900 },
      { x: 1158, y: 0, width: 342, height: 900 },
      { x: 0, y: 0, width: 1500, height: 142 },
    ]);
  });
  it("handles multiple overlapping surfaces on a negative-origin monitor", () => {
    const work = { x: -1500, y: -200, width: 1500, height: 900 };
    const blocks = [{ x: -1200, y: 0, width: 700, height: 700 }, { x: -900, y: -100, width: 800, height: 600 }];
    const areas = shellFreeAreas(work, blocks, 10);
    expect(areas.length).toBeGreaterThan(0);
    for (const area of areas) {
      expect(area.x).toBeGreaterThanOrEqual(work.x);
      expect(area.y).toBeGreaterThanOrEqual(work.y);
      expect(area.x + area.width).toBeLessThanOrEqual(work.x + work.width);
      expect(area.y + area.height).toBeLessThanOrEqual(work.y + work.height);
      for (const block of blocks) expect(area.x + area.width <= block.x - 10 || area.x >= block.x + block.width + 10 || area.y + area.height <= block.y - 10 || area.y >= block.y + block.height + 10).toBe(true);
    }
  });
  it("does not invent space when the shell fills the work area", () => {
    expect(shellFreeAreas(screen, [screen], 8)).toEqual([]);
  });
});

it("keeps shared pill and chat content inside a narrow side strip", async () => {
  const { pillPosition, chatSide, chatWindowFrame } = await import("../../../../src/core/ui/overlayGeometry.js");
  const config = await import("../../../../src/core/config.js");
  const area = { x: 0, y: 0, width: 325, height: 900 };
  const pill = pillPosition({ x: 750, y: 170, width: 1, height: 20 }, area);
  expect(pill.x).toBe(162.5);
  const side = chatSide(pill.y, true, area);
  const frame = chatWindowFrame(pill, 320, area, side, true);
  expect(frame.x + config.chatShadowMargin).toBeGreaterThanOrEqual(area.x);
  expect(frame.x + frame.width - config.chatShadowMargin).toBeLessThanOrEqual(area.x + area.width);
  expect(frame.width - 2 * config.chatShadowMargin).toBe(325);
});
