// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { connectorIDs } from "../../../src/core/agent/connectors/index.js";
import { agentToolIDs } from "../../../src/core/agent/tools.js";
import type { EventQuestionLine } from "../../../src/core/agent/chat.js";
import { ConnectorIcon, EventLineIcon, ExclamationIcon, HistoryIcon, MemoryIcon, SparklesIcon, ToolIcon } from "../../../src/renderer/shared/icons.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

/** `icon` drawn in the page. */
async function drawn(icon: ReactNode): Promise<SVGSVGElement> {
  const holder = document.createElement("div");
  document.body.append(holder);
  await act(async () => createRoot(holder).render(icon));
  const svg = holder.querySelector("svg");
  if (!svg) throw new Error("no svg");
  return svg;
}

/** The tools', the apps', agent mode's and a failure's icons are one color, the theme's accent, in
 * light and dark: no gradient anywhere (owner, 2026-10-09: "It should be a single color"). */
test("every tool and app icon is drawn in the one accent color, no gradient", async () => {
  const icons = [
    ...agentToolIDs.map((tool) => <ToolIcon tool={tool} size={13} />),
    ...connectorIDs.map((connector) => <ConnectorIcon connector={connector} size={13} />),
    <SparklesIcon size={13} />,
    <ExclamationIcon size={13} />,
  ];
  for (const icon of icons) {
    const svg = await drawn(icon);
    expect(svg.querySelector("linearGradient")).toBeNull();
    expect(svg.outerHTML).not.toContain("url(#");
    expect(svg.outerHTML).toContain("var(--accent)");
  }
});

/** Each line of a calendar question's card draws its own glyph: a shape with geometry, not an empty
 * frame, and no two lines alike. */
test("every calendar card line icon draws its own shape", async () => {
  const icons = Object.keys({ repeat: 0, location: 0, calendar: 0, person: 0, notes: 0, availability: 0, mail: 0, deleted: 0 } satisfies Record<EventQuestionLine["icon"], 0>) as EventQuestionLine["icon"][];
  const drawings: string[] = [];
  for (const icon of icons) {
    const svg = await drawn(<EventLineIcon icon={icon} size={12} />);
    const shapes = [...svg.querySelectorAll("path, circle, rect, line, polyline")];
    const hasGeometry = (shape: Element) => (shape.getAttribute("d") ?? "").trim() !== "" || Number(shape.getAttribute("r")) > 0 || Number(shape.getAttribute("width")) > 0 || shape.hasAttribute("points") || shape.hasAttribute("x2");
    expect(shapes.some(hasGeometry), icon).toBe(true);
    drawings.push(svg.innerHTML);
  }
  expect(new Set(drawings).size).toBe(icons.length);
});

/** Memory's icon, a clock with an arrow going back, is one drawing in two colors: Settings' and the
 * welcome's plain one (`HistoryIcon`) and the overlay's accent one (`MemoryIcon`). */
test("memory's icon draws the clock with its arrow, plain in Settings and accented in the overlay", async () => {
  const plain = await drawn(<HistoryIcon size={13} />);
  const accent = await drawn(<MemoryIcon size={13} />);
  for (const svg of [plain, accent]) {
    const d = svg.querySelector("path")?.getAttribute("d") ?? "";
    // The clock face and its arrow going back, and the hands.
    expect(d).toContain("M3.5 12a8.5 8.5 0 1 0");
    expect(d).toContain("M12 7.5V12l3 2");
  }
  expect(accent.outerHTML).toContain("var(--accent)");
  expect(plain.outerHTML).not.toContain("var(--accent)");
});
