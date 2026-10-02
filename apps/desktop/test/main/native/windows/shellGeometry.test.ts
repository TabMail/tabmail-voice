import { expect, it } from "vitest";
import { ShellGeometry } from "../../../../src/main/native/windows/shellGeometry.js";
import type { Rect } from "../../../../src/core/ui/overlayGeometry.js";

it("does not restore stale shell bounds after a newer close snapshot", async () => {
  const requests: Array<(bounds: Rect[]) => void> = [];
  const geometry = new ShellGeometry(() => new Promise(resolve => requests.push(resolve)));
  const old = geometry.refresh();
  const current = geometry.refresh();
  requests[1]!([]);
  expect(await current).toBe(false);
  requests[0]!([{ x: 10, y: 20, width: 800, height: 700 }]);
  expect(await old).toBe(false);
  expect(geometry.bounds).toEqual([]);
});

it("retains known exclusions on failure and recovers on a later query", async () => {
  const bounds = [{ x: 10, y: 20, width: 800, height: 700 }];
  let fail = false;
  let next = bounds;
  const geometry = new ShellGeometry(async () => {
    if (fail) throw new Error("unavailable");
    return next;
  });
  expect(await geometry.refresh()).toBe(true);
  fail = true;
  await expect(geometry.refresh()).rejects.toThrow("unavailable");
  expect(geometry.bounds).toEqual(bounds);
  fail = false;
  next = [];
  expect(await geometry.refresh()).toBe(true);
  expect(geometry.bounds).toEqual([]);
});
