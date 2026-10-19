// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** `shared/form.css`, the stylesheet every window links. */
const css = readFileSync(join(import.meta.dirname, "../../../src/renderer/shared/form.css"), "utf8");

/** The opacity a link button shows, pressed or not, enabled or not. happy-dom cannot hold a mouse
 * button down, so the press is a class standing in for `:active` (both weigh the same in the
 * cascade). */
function opacity({ pressed, disabled }: { pressed: boolean; disabled: boolean }): number {
  document.head.innerHTML = `<style>${css.replaceAll(":active", ".held")}</style>`;
  document.body.innerHTML = '<button class="link">Remove</button>';
  const button = document.querySelector("button") as HTMLButtonElement;
  button.disabled = disabled;
  button.classList.toggle("held", pressed);
  const value = getComputedStyle(button).opacity;
  return value === "" ? 1 : Number(value);
}

test("a link button dims while pressed and comes back when let go, unless it is disabled", () => {
  const resting = opacity({ pressed: false, disabled: false });
  expect(opacity({ pressed: true, disabled: false })).toBeLessThan(resting);
  expect(opacity({ pressed: false, disabled: false })).toBe(resting);
  expect(opacity({ pressed: true, disabled: true })).toBe(opacity({ pressed: false, disabled: true }));
});
