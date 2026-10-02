// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, expect, test, vi } from "vitest";
import { WindowsSystem } from "../../../../src/main/native/windows/system.js";
import { shellPlacementArea } from "../../../../src/main/native/windows/overlayArea.js";
import { WindowsFileStore, windowsSearchSQL } from "../../../../src/main/native/windows/files.js";

// No OS, filesystem, account, or service calls. The real adapters consume recorded fixture replies.
const mocks = vi.hoisted(() => ({ exec: vi.fn(), dip: vi.fn(), open: vi.fn(), reveal: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("electron", () => ({ screen: { screenToDipRect: mocks.dip }, shell: { openPath: mocks.open, showItemInFolder: mocks.reveal } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dip.mockImplementation((_window, r) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 }));
});

test("native shell bounds produce non-overlapping placement and full cover produces no placement", async () => {
  let bounds: unknown = [{ x: 600, y: 100, width: 800, height: 1300 }];
  const requests: unknown[] = [];
  const helper = { request: async (method: string) => { requests.push(method); return bounds; } };
  const system = new WindowsSystem(helper as never);
  const work = { x: 0, y: 0, width: 1000, height: 800 };
  const rects = await system.shellExclusionBounds();
  expect(rects).toEqual([{ x: 300, y: 50, width: 400, height: 650 }]);
  const placed = shellPlacementArea(work, rects);
  expect(placed).not.toBeNull();
  if (!placed) throw new Error("expected usable strip");
  expect(placed.x + placed.width <= 276 || placed.x >= 724 || placed.y + placed.height <= 26 || placed.y >= 724).toBe(true);
  bounds = [{ x: 0, y: 0, width: 2000, height: 1600 }];
  expect(shellPlacementArea(work, await system.shellExclusionBounds())).toBeNull();
  bounds = [];
  expect(shellPlacementArea(work, await system.shellExclusionBounds())).toEqual(work);
  expect(requests).toEqual(["shellExclusionBounds", "shellExclusionBounds", "shellExclusionBounds"]);
});

test("default Search runner delivers a returned row and preserves process failure", async () => {
  const home = "C:\\Users\\ReviewFixture";
  const row = { path: `${home}\\Documents\\report.txt`, name: "report.txt", kind: "Text Document", changed: null, subject: null, authors: [], isEmail: false };
  let fail = false;
  const inputs: string[] = [];
  mocks.exec.mockImplementation((_exe, _args, _opts, callback) => ({ stdin: {
    on: () => {}, end: (input: string) => { inputs.push(input); callback(fail ? new Error("fixture failure") : null, `\uFEFF${JSON.stringify([row])}`); },
  } }));
  const store = new WindowsFileStore(home);
  const query = { words: ["report"], kind: "any" as const, changedAfter: null, changedBefore: null };
  expect(await store.search(query, 5)).toEqual([row]);
  expect(inputs).toHaveLength(1);
  if (inputs.length !== 1) throw new Error("expected query input");
  expect(JSON.parse(inputs[0]!).sql).toBe(windowsSearchSQL(home, query, 5));
  fail = true;
  await expect(store.search(query, 5)).rejects.toThrow("Windows Search could not run the search.");
});
