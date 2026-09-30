// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ConnectorID, connectorInfo, connectorServerTools, connectorIDs } from "./connectors/registry.js";
import { type AgentToolID, isAgentToolID, agentTools } from "./tools.js";

/** One of agent mode's bubbles under the pill: a tool's, or an app's that Answer reaches. */
export type BubbleKey = AgentToolID | ConnectorID;

/** The bubble's name, as Settings shows it. */
export function bubbleName(key: BubbleKey): string {
  return isAgentToolID(key) ? agentTools[key].displayName : connectorInfo[key].displayName;
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

/** The app whose backend tool `tool` is (`connectorServerTools`): the web's search. Null for the
 * backend's own tools, which belong to no app (the date tools). */
export function serverToolConnector(tool: string): ConnectorID | null {
  return connectorIDs.find((connector) => connectorServerTools[connector]?.includes(tool) ?? false) ?? null;
}
