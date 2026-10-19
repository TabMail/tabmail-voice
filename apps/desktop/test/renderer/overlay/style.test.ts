// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** `overlay/index.css` without comments. */
const css = readFileSync(
  join(import.meta.dirname, "../../../src/renderer/overlay/index.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule with exactly `selector`. */
function body(selector: string): string {
  return (
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
      ([, selectors = ""]) => selectors.trim() === selector,
    )?.[2] ?? ""
  );
}

// The layout itself is checked where it is laid out: `npm run preview`'s
// `overlay-chat-confirmation-long` fails when the question's buttons are cut off.
test("a chat taller than its window scrolls, and nothing in it shrinks", () => {
  expect(body(".chat-scroll")).toMatch(/overflow-y:\s*auto;/);
  expect(body(".chat-scroll > *")).toMatch(/flex:\s*none;/);
});

// What a question's confirm button is coloured by: its class alone, red for a delete.
test("the confirm button is the brand blue, and red for a delete", () => {
  expect(body(".chat-confirm")).toMatch(/background:\s*var\(--brand-blue\);/);
  expect(body(".chat-confirm.destructive")).toMatch(/background:\s*var\(--error\);/);
});

// A person's address is as strong as their name, since it is who is emailed; words only a screen
// reader hears take no room on screen; a new value is never underlined.
test("a card's people, screen-reader words and new values are drawn as they should be", () => {
  expect(body(".event-people .event-line-detail")).toMatch(/color:\s*inherit;/);
  expect(body(".sr-only")).toMatch(/position:\s*absolute;/);
  expect(body(".sr-only")).toMatch(/clip-path:\s*inset\(50%\);/);
  expect(body(".event-added")).toMatch(/text-decoration:\s*none;/);
});
