// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desktopExec } from "./autostart.js";

/** The argument every Linux launcher passes (`electron-builder.json`'s `executableArgs`): Electron
 * picks its display backend before the app's code runs, so it can't be added later. */
export const x11Argument = "--ozone-platform=x11";

/**
 * The AppImage this process runs from: `APPIMAGE`, when the executable is in the folder the AppImage's
 * runtime mounted it at (`APPDIR`), else undefined. The runtime sets both for everything it starts,
 * and every process started from there inherits them: the package's app opened from an AppImage's
 * terminal is not that AppImage, and must neither replace it nor put it on the desktop.
 */
export function runningAppImage(env: NodeJS.ProcessEnv, execPath: string): string | undefined {
  const { APPIMAGE: appImage, APPDIR: mount } = env;
  if (appImage === undefined || mount === undefined) return undefined;
  try {
    return realpathSync(mount) === dirname(execPath) ? appImage : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an AppImage started without `x11Argument` (opened from Files or a terminal; the AppImage's
 * own launcher passes no arguments) and so must open itself again with it. */
export function needsX11Relaunch(appImage: string | undefined, argv: readonly string[]): appImage is string {
  return appImage !== undefined && !argv.includes(x11Argument);
}

/**
 * What the package installs system-wide, the AppImage puts in the user's own data folder at each
 * launch (ADR-DESK-059): the launcher entry (`ai.tabmail.voice.desktop`, the app ID the desktop
 * portal knows the app by), the icons, and the GNOME extension (ADR-DESK-052), which GNOME loads
 * from there at the next sign-in. A file is written only when it differs, and through a temporary
 * file, so a launch never leaves one half written. Moving the AppImage moves the entry with the next launch.
 */
export function integrateAppImage(options: { appImage: string; resources: string; dataHome: string }): void {
  const { appImage, resources, dataHome } = options;
  const entry = `[Desktop Entry]\nType=Application\nName=TabMail Voice\nComment=Dictate into the app you are using\nExec=${desktopExec(appImage)} ${x11Argument} %U\nIcon=tabmail-voice\nStartupWMClass=ai.tabmail.voice\nStartupNotify=false\nTerminal=false\nCategories=Utility;\n`;
  write(join(dataHome, "applications", "ai.tabmail.voice.desktop"), Buffer.from(entry));
  const icons = join(resources, "linux", "icons");
  for (const name of readdirSync(icons)) {
    const size = /^(\d+x\d+)\.png$/u.exec(name)?.[1];
    if (size !== undefined) write(join(dataHome, "icons", "hicolor", size, "apps", "tabmail-voice.png"), readFileSync(join(icons, name)));
  }
  const extension = join(resources, "linux", "gnome", "voice-caret@tabmail.ai");
  for (const name of readdirSync(extension)) {
    write(join(dataHome, "gnome-shell", "extensions", "voice-caret@tabmail.ai", name), readFileSync(join(extension, name)));
  }
}

function write(path: string, contents: Buffer): void {
  try {
    if (readFileSync(path).equals(contents)) return;
  } catch {
    // Not there yet.
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o644 });
  renameSync(temporary, path);
}
