// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { alphabetical, bubbleDescription, bubbleName, bubbleOrder, memoryBubble, screenReadBubble, ranNow, serverToolConnector, shownBubbles } from "../../../src/core/agent/bubbleOrder.js";
import { connectorByID, connectorIDs, connectors } from "../../../src/core/agent/connectors/index.js";
import { agentToolIDs, agentTools } from "../../../src/core/agent/tools.js";
import * as config from "../../../src/core/config.js";

/** The order of agent mode's bubbles under the pill, and of Settings' switches. */
describe("bubble order", () => {
  test("a bubble is named as Settings names it", () => {
    expect(bubbleName("compose")).toBe(agentTools.compose.displayName);
    expect(bubbleName("web")).toBe(connectorByID.web.displayName);
    expect(bubbleName(memoryBubble)).toBe(config.memoryBubbleName);
    expect(bubbleDescription("compose")).toBe(agentTools.compose.settingsDescription);
    expect(bubbleDescription("web")).toBe(connectorByID.web.settingsDescription);
    expect(bubbleDescription(memoryBubble)).toBe(config.memoryBubbleDescription);
  });

  /** Memory's tools come with every request that offers a tool, so its bubble shows whenever a tool's
   * does, and never alone. */
  test("memory's bubble shows with the tools'", () => {
    expect(shownBubbles(["compose", "answer"], ["web"])).toEqual(["compose", "answer", memoryBubble, "web"]);
    expect(shownBubbles(["edit"], [])).toEqual(["edit", memoryBubble]);
    expect(shownBubbles([], [])).toEqual([]);
  });

  test("screen reading has a named bubble only when offered", () => {
    expect(shownBubbles(["edit"], [], true)).toEqual(["edit", memoryBubble, screenReadBubble]);
    expect(shownBubbles(["edit"], [], false)).not.toContain(screenReadBubble);
    expect(shownBubbles([], [], true)).toEqual([]);
    expect(bubbleName(screenReadBubble)).toBe(config.screenReadBubbleName);
    expect(bubbleDescription(screenReadBubble)).toBe(config.screenReadBubbleDescription);
  });

  test("tools and apps sort together by name", () => {
    const sorted = alphabetical([...agentToolIDs, ...connectorIDs, memoryBubble]);
    const names = sorted.map(bubbleName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(sorted)).toEqual(new Set([...agentToolIDs, ...connectorIDs, memoryBubble]));
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
    for (const connector of connectors) for (const tool of connector.serverTools ?? []) expect(serverToolConnector(tool)).toBe(connector.id);
    expect(serverToolConnector("search_web")).toBe("web");
    expect(serverToolConnector("date_to_day")).toBeNull();
  });
});
