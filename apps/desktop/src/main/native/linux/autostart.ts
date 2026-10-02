// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Freedesktop Desktop Entry's Exec quoting, including its preceding string unescaping.
 * No shell is involved. Percent is doubled so executable paths cannot introduce field codes. */
export function desktopExec(path: string): string {
  if (!path.startsWith("/") || ["\0", "\r", "\n"].some((character) => path.includes(character))) throw new Error("Invalid application path");
  const quoted = path.replaceAll("%", "%%").replace(/[\\"$`]/gu, (character) => `\\${character}`);
  return `"${quoted.replaceAll("\\", "\\\\")}"`;
}

/** GNOME's standard per-user autostart entry; never edits a system-wide launcher. */
export class LinuxAutostart {
  private readonly path: string;
  private readonly entry: string;
  constructor(configDirectory: string, executable: string, args: readonly string[] = []) {
    this.path = join(configDirectory, "autostart", "ai.tabmail.voice.desktop");
    this.entry = `[Desktop Entry]\nType=Application\nName=TabMail Voice\nExec=${[executable, ...args].map(desktopExec).join(" ")} --ozone-platform=x11\nIcon=tabmail-voice\nStartupWMClass=ai.tabmail.voice\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
  }
  get enabled(): boolean {
    try { return readFileSync(this.path, "utf8") === this.entry; }
    catch { return false; }
  }
  set enabled(value: boolean) {
    if (!value) {
      if (existsSync(this.path)) unlinkSync(this.path);
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, this.entry, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
