// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Connector } from "./contract.js";
import { type ConnectorID, connectors } from "./registry.js";

/** The connectors as the rest of the app reads them: the list (generated into `registry.ts` from
 * each connector's own file), their ids in order, and each by its id. */
export { type ConnectorID, connectors };

export const connectorIDs: readonly ConnectorID[] = connectors.map((connector) => connector.id);

export function isConnectorID(name: unknown): name is ConnectorID {
  return typeof name === "string" && (connectorIDs as readonly string[]).includes(name);
}

export const connectorByID = Object.fromEntries(connectors.map((connector) => [connector.id, connector])) as Record<ConnectorID, Connector>;
