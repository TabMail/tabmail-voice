// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HelperClient } from "../helperClient.js";
import type { GnomeIntegrationState } from "../../../shared/ipc.js";

const runFile = promisify(execFile);
type Run = (file: string, args: readonly string[]) => Promise<string>;
const run: Run = async (file, args) => (await runFile(file, args, { timeout: 3000, maxBuffer: 16384, env: { ...process.env, LC_ALL: "C" } })).stdout;

/** The deb owns the system extension files; activation belongs to this user.
 * Never resets GNOME's extension list or restarts the user's desktop. */
export class GnomeIntegration {
  state: GnomeIntegrationState = "checking";
  onChange: (() => void) | undefined;
  private busy = false;
  constructor(private readonly helper: HelperClient, private readonly command: Run = run) {}

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (await this.ready()) this.state = "ready";
      else {
        const version = await this.command("gnome-shell", ["--version"]);
        if (!/^GNOME Shell 50(?:\.|\s|$)/u.test(version)) this.state = "unsupported";
        else if (this.state !== "restart") this.state = "available";
      }
    } catch { this.state = "unavailable"; }
    finally { this.busy = false; this.onChange?.(); }
  }

  async enable(): Promise<void> {
    if (this.busy || this.state === "unsupported") return;
    this.busy = true;
    try {
      // This preserves all other extensions and respects GNOME's version checks.
      await this.command("gnome-extensions", ["enable", "voice-caret@tabmail.ai"]);
      this.state = await this.ready() ? "ready" : "restart";
    } catch (error: unknown) {
      const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      this.state = /does not exist|not found/u.test(stderr) ? "restart" : "unavailable";
    }
    finally { this.busy = false; this.onChange?.(); }
  }

  private async ready(): Promise<boolean> {
    try { return await this.helper.request("gnomeIntegration", {}, 1000) === true; }
    catch { return false; }
  }
}
