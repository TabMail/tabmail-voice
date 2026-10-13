// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { desktopExec, LinuxAutostart } from "../../../../src/main/native/linux/autostart.js";

test("Linux login setting creates, reads and removes only its own launcher", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-autostart-"));
  try {
    const setting = new LinuxAutostart(directory, "/opt/TabMail Voice/tabmail", ["/dev/voice source"]);
    expect(setting.enabled).toBe(false);
    setting.enabled = true;
    expect(setting.enabled).toBe(true);
    const path = join(directory, "autostart", "ai.tabmail.voice.desktop");
    expect(readFileSync(path, "utf8")).toContain('Exec="/opt/TabMail Voice/tabmail" "/dev/voice source" --ozone-platform=x11\n');
    const other = join(directory, "autostart", "other.desktop");
    writeFileSync(other, "synthetic other app");
    setting.enabled = false;
    expect(setting.enabled).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("synthetic other app");
    setting.enabled = false;
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("Exec treats field codes and shell metacharacters as literal path text", () => {
  expect(desktopExec('/opt/Voice %U "$x`file\\run')).toBe('"/opt/Voice %%U \\\\"\\\\$x\\\\`file\\\\\\\\run"');
  expect(() => desktopExec("relative")).toThrow();
  expect(() => desktopExec("/app\nExec=other")).toThrow();
  expect(() => desktopExec("/app\0other")).toThrow();
});
