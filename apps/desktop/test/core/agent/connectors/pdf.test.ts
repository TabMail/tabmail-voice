// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test, vi } from "vitest";
import { PDFReadTool } from "../../../../src/core/agent/connectors/pdf.js";

test("resolved path and range are confirmed, then the prepared request runs once", async () => {
  const read = vi.fn().mockResolvedValue("redacted text");
  const tool = new PDFReadTool({ prepare: async () => ({ path: "/home/example/real.pdf", read }) });
  const args = { path: "~/alias.pdf", start_page: 2, page_count: 3 };
  const signal = new AbortController().signal;
  await expect(tool.run(args, signal)).rejects.toThrow("confirmation");
  expect(await tool.confirmation(args, signal)).toContain("/home/example/real.pdf");
  expect(read).not.toHaveBeenCalled();
  args.start_page = 7;
  expect(await tool.run(args, signal)).toBe("redacted text");
  expect(read).toHaveBeenCalledWith({ startPage: 2, pageCount: 3 }, signal);
  await expect(tool.run(args, signal)).rejects.toThrow("confirmation");
});

test.each([{ path: "a", start_page: 0 }, { path: "a", page_count: 11 }, { path: "a", page_count: 0.5 }, {}])("invalid request never prepares a file (%j)", async (args) => {
  const prepare = vi.fn();
  await expect(new PDFReadTool({ prepare }).confirmation(args, new AbortController().signal)).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled();
});

/** A request canceled while its file was being prepared asks nothing and can't be run. */
test("a request canceled during preparation is never asked or run", async () => {
  const read = vi.fn();
  const controller = new AbortController();
  const tool = new PDFReadTool({ prepare: async () => { controller.abort(); return { path: "/home/example/real.pdf", read }; } });
  const args = { path: "~/real.pdf" };
  await expect(tool.confirmation(args, controller.signal)).rejects.toThrow("canceled");
  await expect(tool.run(args, new AbortController().signal)).rejects.toThrow("confirmation");
  expect(read).not.toHaveBeenCalled();
});
