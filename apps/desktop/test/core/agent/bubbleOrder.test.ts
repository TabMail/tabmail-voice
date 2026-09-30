// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { alphabetical, bubbleName, bubbleOrder, ranNow, serverToolConnector } from "../../../src/core/agent/bubbleOrder.js";
import { connectorInfo, connectors, connectorServerTools } from "../../../src/core/agent/connectors/connectors.js";
import { agentTools, toolImplementations } from "../../../src/core/agent/agentTools.js";

/** The order of agent mode's bubbles under the pill, and of Settings' switches. */
describe("bubble order", () => {
  test("a bubble is named as Settings names it", () => {
    expect(bubbleName("compose")).toBe(toolImplementations.compose.displayName);
    expect(bubbleName("web")).toBe(connectorInfo.web.displayName);
  });

  test("tools and apps sort together by name", () => {
    const sorted = alphabetical([...agentTools, ...connectors]);
    const names = sorted.map(bubbleName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(sorted)).toEqual(new Set([...agentTools, ...connectors]));
  });

  /** Those that ran lead, the latest first, then the rest alphabetically; one that ran but no longer
   * shows (turned off) takes no place. */
  test("the latest to run lead the row", () => {
    expect(bubbleOrder(["edit", "answer", "calendar", "web"], [])).toEqual(["answer", "calendar", "edit", "web"]);
    expect(bubbleOrder(["edit", "answer", "calendar", "web"], ["web", "notes", "edit"])).toEqual(["web", "edit", "answer", "calendar"]);
  });

  test("a tool that runs moves to the front, once", () => {
    let recent = ranNow([], "answer");
    recent = ranNow(recent, "web");
    recent = ranNow(recent, "answer");
    expect(recent).toEqual(["answer", "web"]);
  });

  /** A backend tool belongs to the app whose server tools list it; the backend's own (the date tools)
   * to none. */
  test("a backend tool's app", () => {
    for (const connector of connectors) for (const tool of connectorServerTools[connector] ?? []) expect(serverToolConnector(tool)).toBe(connector);
    expect(serverToolConnector("search_web")).toBe("web");
    expect(serverToolConnector("date_to_day")).toBeNull();
  });
});
