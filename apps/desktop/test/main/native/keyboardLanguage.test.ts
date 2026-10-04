// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { MacSystem } from "../../../src/main/native/macos/system.js";
import { WindowsSystem } from "../../../src/main/native/windows/system.js";
import { LinuxSystem } from "../../../src/main/native/linux/system.js";
import type { HelperClient } from "../../../src/main/native/helperClient.js";

vi.mock("electron", () => ({ screen: { screenToDipRect: vi.fn() } }));

// Exercise each public caller, so accidentally retaining native-platform normalization fails.
for (const System of [MacSystem, WindowsSystem, LinuxSystem]) {
  describe(System.name, () => {
    test.each([
      ["ko", "ko"], ["en-US", "en"], ["EN", "en"], ["zh-Hans", "zh"],
      ["pt_BR", "pt"], ["sr-Latn-RS", "sr"], ["eng", "en"], ["iw", "he"],
      ["yue", null], ["fil-PH", null], ["e1", null], ["", null],
      ["-en", null], ["en--US", null], ["en US", null], ["und", null],
      [null, null], [42, null], [[], null], [{}, null],
    ])("locale %j produces transcription language %j", async (code, expected) => {
      const request = vi.fn().mockResolvedValue({ code });
      const system = new System({ request } as unknown as HelperClient);
      expect(await system.keyboardLanguage()).toBe(expected);
      expect(request).toHaveBeenCalledExactlyOnceWith("keyboardLanguage");
    });

    test.each([null, {}, { code: undefined }])("missing locale in %j returns no language", async (reply) => {
      const request = vi.fn().mockResolvedValue(reply);
      expect(await new System({ request } as unknown as HelperClient).keyboardLanguage()).toBeNull();
    });
  });
}
