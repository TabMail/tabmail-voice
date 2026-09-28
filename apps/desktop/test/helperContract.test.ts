// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import type { HelperClient } from "../src/main/helperClient.js";
import { MacSystem } from "../src/main/macos.js";

/** The two sides of the helpers' wire: the requests the app sends and the handlers the Swift helpers
 * register (`channel.on("method")`), each with the params it reads. A method or param renamed on one
 * side only would fail every request at run time while both sides' own tests pass. */

const root = join(__dirname, "..");

/** Each method the helper source registers, with the params its handler reads. */
function registered(source: string): Map<string, Set<string>> {
  const handlers = new Map<string, Set<string>>();
  // The handlers, up to the helper functions declared after them.
  const text = readFileSync(join(root, source), "utf8").split(/\n\s*private static func/)[0] ?? "";
  const sections = text.split(/channel\.on\("/).slice(1);
  for (const section of sections) {
    const method = section.slice(0, section.indexOf('"'));
    const params = new Set([...section.matchAll(/params\["(\w+)"\]/g)].map((match) => match[1] ?? ""));
    if (/bundleIdentifier\(params\)/.test(section)) params.add("bundleIdentifier");
    handlers.set(method, params);
  }
  return handlers;
}

/** A `voice-macos` that answers every request with an empty result, recording what was asked. */
function recordingHelper(): { helper: HelperClient; requests: { method: string; params: Record<string, unknown> }[] } {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const helper = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      requests.push({ method, params });
      return { value: false, path: null, code: null, systemDefault: null, installed: [] };
    },
  } as unknown as HelperClient;
  return { helper, requests };
}

describe("helper wire contract", () => {
  test("every request MacSystem sends is one voice-macos handles, with the params it reads", async () => {
    const { helper, requests } = recordingHelper();
    const mac = new MacSystem(helper);
    const app = "org.example.app";
    await mac.paste("text");
    await mac.frontmostApp();
    await mac.keyboardLanguage();
    await mac.systemEmailApp();
    await mac.emailApps([app]);
    await mac.readScreen();
    await mac.caretAnchor(1);
    await mac.startActivator();
    await mac.globeKey.read();
    await mac.globeKey.update(0);
    await mac.thunderbird.applicationPath(app);
    await mac.thunderbird.isRunning(app);
    await mac.thunderbird.launch("/Applications/Example.app");
    await mac.thunderbird.hasWindow(app);
    await mac.thunderbird.activate(app);
    await mac.thunderbird.isFrontmost(app);
    await mac.thunderbird.focusedElement(app);
    await mac.thunderbird.openChat();
    await mac.thunderbird.pressReturn();

    const handlers = registered("native/macos/Sources/VoiceMacOSKit/MacService.swift");
    expect(new Set(requests.map((request) => request.method))).toEqual(new Set(handlers.keys()));
    for (const { method, params } of requests) {
      for (const param of handlers.get(method) ?? []) expect(params, `${method} without ${param}`).toHaveProperty(param);
    }
  });

  /** Values, not only names: the paste's text and its restore delay in the seconds the helper reads,
   * and the frontmost app's process as the helper answers it. */
  test("a paste carries its text and a restore delay in seconds, and the frontmost app's reply keeps its process", async () => {
    const calls: { method: string; params: unknown; timeout: unknown }[] = [];
    const helper = {
      request: async (method: string, params?: unknown, timeout?: unknown) => {
        calls.push({ method, params, timeout });
        return method === "frontmostApp" ? { pid: 321 } : {};
      },
    } as unknown as HelperClient;
    const mac = new MacSystem(helper);

    await mac.paste("some text");
    expect(await mac.frontmostApp()).toBe(321);

    expect(calls).toEqual([
      { method: "insert", params: { text: "some text", restoreDelay: config.clipboardRestoreDelay / 1000 }, timeout: config.helperRequestTimeout + config.clipboardRestoreDelay },
      { method: "frontmostApp", params: undefined, timeout: undefined },
    ]);
  });

  test("every request the app sends voice-hotkey is one it handles, with the params it reads", () => {
    const main = readFileSync(join(root, "src/main/main.ts"), "utf8");
    const sent = [...main.matchAll(/hotkeyHelper\s*\.request(?:<[^>]*>)?\("(\w+)"(?:,\s*\{([^}]*)\})?/g)].map((match) => ({
      method: match[1] ?? "",
      params: new Set([...(match[2] ?? "").matchAll(/(\w+)\s*(?:[:,]|$)/g)].map((param) => param[1] ?? "")),
    }));

    const handlers = registered("native/macos/Sources/VoiceHotkeyKit/HotkeyService.swift");
    expect(new Set(sent.map((request) => request.method))).toEqual(new Set(handlers.keys()));
    for (const { method, params } of sent) {
      for (const param of handlers.get(method) ?? []) expect(params, `${method} without ${param}`).toContain(param);
    }
  });
});
