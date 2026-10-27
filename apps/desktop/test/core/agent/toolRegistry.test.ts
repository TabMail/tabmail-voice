// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "vitest";
import { ToolRegistry, type RegisteredTool } from "../../../src/core/agent/toolRegistry.js";
import type { ToolCall } from "../../../src/core/backend/completions.js";

const call = (name: string): ToolCall => ({ id: "call-1", function: { name, arguments: "{}" } });
const tool = (name: string, extra: Partial<RegisteredTool> = {}): RegisteredTool => ({ name, terminal: false, run: async () => name, ...extra });

test("new tools execute by registered name and terminal property", async () => {
  const registry = new ToolRegistry([tool("new_lookup"), tool("new_final", { terminal: true })]);
  expect(await registry.execute(call("new_lookup"), 0)).toEqual({ tool: "new_lookup", text: "new_lookup", terminal: false });
  expect(await registry.execute(call("new_final"), 1)).toEqual({ tool: "new_final", text: "new_final", terminal: true });
});

test("a normal response executes the configured response handler", async () => {
  const heard: string[] = [];
  const registry = new ToolRegistry([tool("display_reply", { terminal: true, response: true, advertise: false, run: async (called) => {
    const args = JSON.parse(called.function.arguments) as { text: string };
    heard.push(args.text);
    return args.text;
  } })]);
  expect(registry.names).toEqual([]);
  expect(await registry.respond("Hello", 2)).toEqual({ tool: "display_reply", text: "Hello", terminal: true });
  expect(heard).toEqual(["Hello"]);
});

test("unknown tools never run another handler", async () => {
  let ran = false;
  const registry = new ToolRegistry([tool("enabled", { run: async () => { ran = true; return ""; } })]);
  expect(await registry.execute(call("disabled"), 0)).toEqual({ tool: "disabled", text: "Error: there is no tool named disabled.", terminal: false });
  expect(ran).toBe(false);
});

test("activity ends when execution fails", async () => {
  const events: boolean[] = [];
  const failure = new Error("failed");
  const registry = new ToolRegistry([tool("failing", { run: async () => { throw failure; } })], (_, running) => events.push(running));
  await expect(registry.execute(call("failing"), 0)).rejects.toBe(failure);
  expect(events).toEqual([true, false]);
});

test("server tools share registered activity and cannot run locally", async () => {
  const events: [string, boolean, string | null][] = [];
  let localRuns = 0;
  const registry = new ToolRegistry([tool("server_lookup", { run: undefined }), tool("local", { run: async () => { localRuns++; return "local result"; } })], (definition, running, label) => events.push([definition.name, running, label ?? null]));
  registry.serverEvent({ tool: "server_lookup", running: true, label: "Looking" });
  registry.serverEvent({ tool: "unknown", running: true, label: "Ignored" });
  registry.serverEvent({ tool: "local", running: true, label: "Ignored local" });
  registry.serverEvent({ tool: "local", running: false, label: null });
  expect(localRuns).toBe(0);
  registry.serverEvent({ tool: "server_lookup", running: false, label: null });
  expect(registry.names).toEqual(["server_lookup", "local"]);
  expect(events).toEqual([["server_lookup", true, "Looking"], ["server_lookup", false, null]]);
  expect((await registry.execute(call("server_lookup"), 0)).terminal).toBe(false);
  expect(await registry.execute(call("local"), 0)).toEqual({ tool: "local", text: "local result", terminal: false });
  expect(localRuns).toBe(1);
  expect(events.slice(2)).toEqual([["local", true, null], ["local", false, null]]);
});

test("an unavailable response handler cannot deliver a reply", () => {
  expect(() => new ToolRegistry([]).respond("Hello", 0)).toThrow();
});

test("duplicate names and ambiguous response handlers are refused", () => {
  expect(() => new ToolRegistry([tool("same"), tool("same")])).toThrow();
  const a = tool("a", { response: true, terminal: true });
  const b = tool("b", { response: true, terminal: true });
  expect(() => new ToolRegistry([a])).not.toThrow();
  expect(() => new ToolRegistry([b])).not.toThrow();
  expect(() => new ToolRegistry([a, b])).toThrow();
});

test("only client call attempts consume the before-call policy, including unknown calls", async () => {
  const calls: (string | null)[] = [];
  const registry = new ToolRegistry([tool("local"), tool("remote", { run: undefined })], () => {}, (definition) => calls.push(definition?.name ?? null));
  registry.serverEvent({ tool: "remote", running: true, label: "Looking" });
  await registry.perform("local", async () => "confirmed effect");
  expect(calls).toEqual([]);
  await registry.execute(call("local"), 0);
  await registry.execute(call("not_registered"), 1);
  expect(calls).toEqual(["local", null]);
});

test("prepared effects share activity without starting while confirmation is pending", async () => {
  const events: boolean[] = [];
  const registry: ToolRegistry = new ToolRegistry([tool("prepared", { deferredActivity: true, run: async () => {
    expect(events).toEqual([]);
    return registry.perform("prepared", async () => { expect(events).toEqual([true]); return "done"; });
  } })], (_, running) => events.push(running));
  expect((await registry.execute(call("prepared"), 0)).text).toBe("done");
  expect(events).toEqual([true, false]);
  await expect(registry.perform("missing", async () => "wrong")).rejects.toThrow();
});

test("a configured response must have a local terminal handler", () => {
  expect(() => new ToolRegistry([tool("response", { response: true })])).toThrow();
  expect(() => new ToolRegistry([tool("response", { response: true, terminal: true, run: undefined })])).toThrow();
});
