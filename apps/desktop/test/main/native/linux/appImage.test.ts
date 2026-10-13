// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { integrateAppImage, needsX11Relaunch, x11Argument } from "../../../../src/main/native/linux/appImage.js";

let folder: string;
let resources: string;
let dataHome: string;
const extension = () => join(dataHome, "gnome-shell", "extensions", "voice-caret@tabmail.ai");
const entry = () => join(dataHome, "applications", "ai.tabmail.voice.desktop");

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "voice-appimage-"));
  resources = join(folder, "resources");
  dataHome = join(folder, "share");
  mkdirSync(join(resources, "linux", "icons"), { recursive: true });
  mkdirSync(join(resources, "linux", "gnome", "voice-caret@tabmail.ai"), { recursive: true });
  writeFileSync(join(resources, "linux", "icons", "256x256.png"), "icon 256");
  writeFileSync(join(resources, "linux", "icons", "48x48.png"), "icon 48");
  writeFileSync(join(resources, "linux", "icons", "README.md"), "not an icon");
  writeFileSync(join(resources, "linux", "gnome", "voice-caret@tabmail.ai", "metadata.json"), "{}");
  writeFileSync(join(resources, "linux", "gnome", "voice-caret@tabmail.ai", "extension.js"), "export default class {}");
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("the AppImage's place on the desktop (ADR-DESK-059)", () => {
  test("its launcher entry opens this AppImage with the X11 argument, under the app's ID", () => {
    integrateAppImage({ appImage: "/home/user/My Apps/TabMail Voice.AppImage", resources, dataHome });

    expect(readFileSync(entry(), "utf8")).toBe(
      '[Desktop Entry]\nType=Application\nName=TabMail Voice\nComment=Dictate into the app you are using\nExec="/home/user/My Apps/TabMail Voice.AppImage" --ozone-platform=x11 %U\nIcon=tabmail-voice\nStartupWMClass=ai.tabmail.voice\nStartupNotify=false\nTerminal=false\nCategories=Utility;\n',
    );
  });

  test("its icons go in the user's icon theme, by size, and the GNOME extension in the user's extensions", () => {
    integrateAppImage({ appImage: "/home/user/TabMail.AppImage", resources, dataHome });

    expect(readFileSync(join(dataHome, "icons", "hicolor", "256x256", "apps", "tabmail-voice.png"), "utf8")).toBe("icon 256");
    expect(readFileSync(join(dataHome, "icons", "hicolor", "48x48", "apps", "tabmail-voice.png"), "utf8")).toBe("icon 48");
    expect(readdirSync(join(dataHome, "icons", "hicolor")).sort()).toEqual(["256x256", "48x48"]);
    expect(readdirSync(extension()).sort()).toEqual(["extension.js", "metadata.json"]);
    expect(readFileSync(join(extension(), "extension.js"), "utf8")).toBe("export default class {}");
  });

  test("a moved AppImage, or an updated extension, is written again; what is already right is left alone", () => {
    integrateAppImage({ appImage: "/home/user/TabMail.AppImage", resources, dataHome });
    const written = statSync(join(extension(), "metadata.json")).mtimeMs;
    const icon = statSync(join(dataHome, "icons", "hicolor", "48x48", "apps", "tabmail-voice.png")).ino;
    writeFileSync(join(resources, "linux", "gnome", "voice-caret@tabmail.ai", "extension.js"), "export default class Newer {}");

    integrateAppImage({ appImage: "/home/user/Apps/TabMail.AppImage", resources, dataHome });

    expect(readFileSync(entry(), "utf8")).toContain('Exec="/home/user/Apps/TabMail.AppImage" ');
    expect(readFileSync(join(extension(), "extension.js"), "utf8")).toBe("export default class Newer {}");
    expect(statSync(join(extension(), "metadata.json")).mtimeMs).toBe(written);
    expect(statSync(join(dataHome, "icons", "hicolor", "48x48", "apps", "tabmail-voice.png")).ino).toBe(icon);
    expect(readdirSync(join(dataHome, "applications"))).toEqual(["ai.tabmail.voice.desktop"]);
  });

  test("an AppImage path a launcher entry can't name is refused", () => {
    expect(() => integrateAppImage({ appImage: "relative/TabMail.AppImage", resources, dataHome })).toThrow("Invalid application path");
  });
});

describe("the X11 argument", () => {
  test("an AppImage started without it opens itself again; one started with it, or the package, doesn't", () => {
    expect(needsX11Relaunch("/home/user/TabMail.AppImage", ["/tmp/.mount_x/tabmail-voice", "--no-sandbox"])).toBe(true);
    expect(needsX11Relaunch("/home/user/TabMail.AppImage", ["/tmp/.mount_x/tabmail-voice", x11Argument, "--no-sandbox"])).toBe(false);
    expect(needsX11Relaunch(undefined, ["/opt/TabMail Voice/tabmail-voice"])).toBe(false);
  });
});
