// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { connectorIDs } from "../../../src/core/agent/connectors/index.js";
import { agentToolIDs } from "../../../src/core/agent/tools.js";
import { ConnectorIcon, ExclamationIcon, SparklesIcon, ToolIcon } from "../../../src/renderer/shared/icons.js";

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
