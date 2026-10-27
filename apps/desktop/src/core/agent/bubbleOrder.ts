// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { type ConnectorID, connectorByID } from "./connectors/index.js";
import { type AgentToolID, isAgentToolID, agentTools } from "./tools.js";

/** The bubble of the memory tools and the knowledge base's, which come with every request that offers a tool
 * (`ToolRegistry`): it shows with the tools' bubbles and runs while they do (owner,
 * 2026-10-19). It has no switch in Settings. */
export const memoryBubble = "memory" as const;
/** The optional whole-window reading tool. */
export const screenReadBubble = "screen_read" as const;

/** One of agent mode's bubbles under the pill: a tool's, an app's that Answer reaches, or memory's. */
export type BubbleKey = AgentToolID | ConnectorID | typeof memoryBubble | typeof screenReadBubble;

/** The bubble's name, as Settings shows it. */
export function bubbleName(key: BubbleKey): string {
  if (key === memoryBubble) return config.memoryBubbleName;
  if (key === screenReadBubble) return config.screenReadBubbleName;
  return isAgentToolID(key) ? agentTools[key].displayName : connectorByID[key].displayName;
}

/** The bubbles agent mode shows, before their order: the `tools` offered, memory's whenever any is
 * (its tools come with them), and the `apps` Answer reaches. */
export function shownBubbles(tools: readonly AgentToolID[], apps: readonly ConnectorID[], readsWindow = false): BubbleKey[] {
  return [...tools, ...(tools.length > 0 ? [memoryBubble, ...(readsWindow ? [screenReadBubble] : [])] : []), ...apps];
}

/** What the bubble's tooltip says it does, as Settings does. */
export function bubbleDescription(key: BubbleKey): string {
  if (key === memoryBubble) return config.memoryBubbleDescription;
  if (key === screenReadBubble) return config.screenReadBubbleDescription;
  return isAgentToolID(key) ? agentTools[key].settingsDescription : connectorByID[key].settingsDescription;
}

/** `keys` in alphabetical order of their names (owner, 2026-09-28: "sort of alphabetical"), as Settings
 * lists them and the bubbles first show. */
export function alphabetical<Key extends BubbleKey>(keys: readonly Key[]): Key[] {
  return [...keys].sort((a, b) => bubbleName(a).localeCompare(bubbleName(b)));
}

/** The bubbles under the pill, left to right: those that ran, the most recent first, then the rest
 * alphabetically (owner, 2026-09-28: "the most recent run tool just appears on the left … shifting the
 * other tools to the right", a history of how the tools ran). Only `shown` ones; `recent` is most
 * recent first. */
export function bubbleOrder(shown: readonly BubbleKey[], recent: readonly BubbleKey[]): BubbleKey[] {
  const ran = recent.filter((key) => shown.includes(key));
  return [...ran, ...alphabetical(shown.filter((key) => !ran.includes(key)))];
}

/** `recent` with `key` moved to the front, as it runs. */
export function ranNow(recent: readonly BubbleKey[], key: BubbleKey): BubbleKey[] {
  return [key, ...recent.filter((other) => other !== key)];
}
