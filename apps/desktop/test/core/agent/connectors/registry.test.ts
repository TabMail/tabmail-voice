// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ConnectorServices } from "../../../../src/core/agent/connectors/contract.js";
import { connectorByID, connectorIDs, connectors, isConnectorID } from "../../../../src/core/agent/connectors/index.js";
import { connectorDeclarations, connectorRegistry } from "../../../../scripts/gen-registries.mjs";
import { FakeScriptRunner } from "../../../support/stubs.js";

/** What the connectors' tools are made over: none of it is called here, only handed to the tools. */
const services = { home: "/Users/example", scriptRunner: new FakeScriptRunner() } as unknown as ConnectorServices;

/** The list of connectors is generated from their own files (ADR-DESK-044): a new connector is one
 * file, and the registry can't fall behind it. */
describe("the connector registry", () => {
  test("registry.ts is what the generator writes (run `npm run gen:registries`)", () => {
    const registry = readFileSync(join(__dirname, "../../../../src/core/agent/connectors/registry.ts"), "utf8");
    expect(registry).toBe(connectorRegistry());
  });

  /** Settings, the welcome wizard and the bubbles list them in this order. */
  test("lists every connector once, in its order", () => {
    expect(connectorIDs).toEqual(["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"]);
    expect(connectors.map((connector) => connector.order)).toEqual([...connectors.map((connector) => connector.order)].sort((a, b) => a - b));
    for (const id of connectorIDs) expect(connectorByID[id].id).toBe(id);
  });

  test("each connector's tools are switched by it, and no tool name is used twice", () => {
    const names: string[] = [];
    for (const connector of connectors) {
      const tools = connector.tools(services);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.connector).toBe(connector.id);
        names.push(tool.name);
      }
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test("only a connector's id is one", () => {
    expect(connectorIDs.every(isConnectorID)).toBe(true);
    expect(["thunderbird", "Calendar", "", null, 1].some(isConnectorID)).toBe(false);
  });
});

describe("the registry generator", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function folderWith(files: Record<string, string>): string {
    const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
    folders.push(folder);
    for (const [name, source] of Object.entries(files)) writeFileSync(join(folder, name), source);
    return folder;
  }

  const declaration = (constant: string, id: string, order: number) => `export const ${constant} = defineConnector({\n  id: "${id}",\n  order: ${order},\n  displayName: "",\n});\n`;

  test("orders the connectors by `order`, whatever their files' names", () => {
    const folder = folderWith({ "a.ts": declaration("laterConnector", "later", 20), "b.ts": declaration("earlierConnector", "earlier", 10), "registry.ts": "ignored" });
    expect(connectorDeclarations(folder).map(({ id, file }) => [id, file])).toEqual([["earlier", "b.ts"], ["later", "a.ts"]]);
    expect(connectorRegistry(folder)).toContain('export type ConnectorID = "earlier" | "later";');
    expect(connectorRegistry(folder)).toContain("export const connectors: readonly Connector[] = [earlierConnector, laterConnector];");
  });

  test.each([
    ["a declaration it can't read", { "a.ts": 'const hidden = defineConnector({ id: "hidden", order: 10 });\n' }, "every defineConnector call must read"],
    ["an id declared twice", { "a.ts": declaration("oneConnector", "same", 10), "b.ts": declaration("otherConnector", "same", 20) }, 'connector id "same" is declared twice'],
    ["an order used twice", { "a.ts": declaration("oneConnector", "one", 10), "b.ts": declaration("otherConnector", "other", 10) }, "connector order 10 is used twice"],
  ])("refuses %s", (_, files, message) => {
    expect(() => connectorDeclarations(folderWith(files))).toThrow(message);
  });
});
