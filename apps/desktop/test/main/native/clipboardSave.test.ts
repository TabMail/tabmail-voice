// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test, vi } from "vitest";
import { type HelperClient, HelperError } from "../../../src/main/native/helperClient.js";
import { LinuxSystem } from "../../../src/main/native/linux/system.js";
import { MacSystem } from "../../../src/main/native/macos/system.js";
import { WindowsSystem } from "../../../src/main/native/windows/system.js";

vi.mock("electron", () => ({ screen: {} }));

/** A clipboard save is never waited for (ADR-DESK-002): the paste goes ahead while it is under way,
 * and a save the helper times out on, exits during or refuses ends quietly, with the next paste as
 * it would be. */
for (const [platform, System] of [["macOS", MacSystem], ["Windows", WindowsSystem], ["Ubuntu", LinuxSystem]] as const) {
  for (const kind of ["timeout", "exited", "failed"] as const) {
    test(`${platform}: a clipboard save that ends in ${kind} holds up no paste and rejects nowhere`, async () => {
      let fail: (error: Error) => void = () => {};
      const save = new Promise<unknown>((_resolve, reject) => {
        fail = reject;
      });
      const methods: string[] = [];
      const inserted: string[] = [];
      // A plain function, not vi.fn: a mock that watched the promise it returns would handle its
      // rejection itself, and an unhandled one would go unseen.
      const helper = {
        request(method: string, params?: { text?: string }) {
          methods.push(method);
          if (method === "clipboardSave") return save;
          if (method === "insert" && params?.text !== undefined) inserted.push(params.text);
          return Promise.resolve({});
        },
      } as unknown as HelperClient;
      const system = new System(helper);
      const paste = (text: string) => (system instanceof MacSystem ? system.paste(text, new AbortController().signal) : system.paste(text, new AbortController().signal, 101));
      const escaped: unknown[] = [];
      const listener = (reason: unknown) => escaped.push(reason);
      process.on("unhandledRejection", listener);
      try {
        system.saveClipboard();
        await paste("First text");
        expect(inserted).toEqual(["First text"]);
        fail(new HelperError(kind, "clipboardSave", "synthetic failure"));
        await new Promise((resolve) => setImmediate(resolve));
        expect(escaped).toEqual([]);
        await paste("Next text");
        expect(inserted).toEqual(["First text", "Next text"]);
        expect(methods).toEqual(["clipboardSave", "insert", "insert"]);
      } finally {
        process.off("unhandledRejection", listener);
      }
    });
  }
}
