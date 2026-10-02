// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { expect, test, vi } from "vitest";
import type { HelperClient } from "../../../../src/main/native/helperClient.js";
import { GnomeIntegration } from "../../../../src/main/native/linux/gnomeIntegration.js";

function fixture() {
  const request = vi.fn().mockResolvedValue(false);
  const command = vi.fn().mockResolvedValue("GNOME Shell 50.1\n");
  const integration = new GnomeIntegration({ request } as unknown as HelperClient, command);
  return { integration, request, command };
}
test("checks the live protocol rather than trusting that extension files exist", async () => {
  const f = fixture();
  await f.integration.refresh(); expect(f.integration.state).toBe("available");
  f.request.mockResolvedValue(true);
  await f.integration.refresh(); expect(f.integration.state).toBe("ready");
  expect(f.request).toHaveBeenCalledWith("gnomeIntegration", {}, 1000);
});
test("activates only its own extension and reports a new-session requirement honestly", async () => {
  const f = fixture();
  await f.integration.enable(); expect(f.integration.state).toBe("restart");
  expect(f.command).toHaveBeenCalledExactlyOnceWith("gnome-extensions", ["enable", "voice-caret@tabmail.ai"]);
  await f.integration.refresh(); expect(f.integration.state).toBe("restart");
  f.request.mockResolvedValue(true);
  await f.integration.enable(); expect(f.integration.state).toBe("ready");
});
test("does not disable version checking on unsupported GNOME releases", async () => {
  const f = fixture(); f.command.mockResolvedValue("GNOME Shell 49.4\n");
  await f.integration.refresh(); expect(f.integration.state).toBe("unsupported");
  f.command.mockClear(); await f.integration.enable(); expect(f.command).not.toHaveBeenCalled();
});
test("handles a missing desktop tool without an unhandled rejection", async () => {
  const f = fixture(); f.command.mockRejectedValue(new Error("missing"));
  await f.integration.refresh(); expect(f.integration.state).toBe("unavailable");
});

test("a missing newly installed extension requests login, but command failures do not", async () => {
  const f = fixture(); f.command.mockRejectedValue({ stderr: "Extension voice-caret@tabmail.ai does not exist" });
  await f.integration.enable(); expect(f.integration.state).toBe("restart");
  f.command.mockRejectedValue(new Error("permission denied"));
  await f.integration.enable(); expect(f.integration.state).toBe("unavailable");
});

test("recording notification crosses the hotkey helper without shell commands", async () => {
  const f = fixture();
  await f.integration.recordingStarted();
  expect(f.request).toHaveBeenCalledExactlyOnceWith("setRecording", { active: true });
  expect(f.command).not.toHaveBeenCalled();
});
