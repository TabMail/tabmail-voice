// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { nativeImage, type NativeImage } from "electron";

/** GNOME's standard panel is dark regardless of the app theme. KDE's standard
 * panel follows the system theme. Both consume the same StatusNotifier icon. */
export function linuxTrayUsesLightText(desktop: string, darkTheme: boolean): boolean {
  return desktop.split(":").some((name) => name.toLowerCase() === "gnome") || darkTheme;
}

/** Preserve the shared text glyph and its alpha mask; Linux hosts do not apply
 * macOS template-image tinting. NativeImage's Linux bitmap is premultiplied BGRA. */
export function linuxTrayIcon(template: NativeImage, lightText: boolean): NativeImage {
  const bitmap = template.toBitmap({ scaleFactor: 1 });
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const color = lightText ? bitmap[offset + 3]! : 0;
    bitmap[offset] = color;
    bitmap[offset + 1] = color;
    bitmap[offset + 2] = color;
  }
  return nativeImage.createFromBitmap(bitmap, template.getSize(1));
}
