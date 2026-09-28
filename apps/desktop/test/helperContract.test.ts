// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import { hotkeyActions } from "../src/core/hotkey.js";
import type { HelperClient } from "../src/main/helperClient.js";
import { decodeSamples, MacSystem } from "../src/main/macos.js";
import type { AudioReport } from "../src/shared/ipc.js";

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
      return { value: false, path: null, code: null, systemDefault: null, installed: [], png: null };
    },
    on() {},
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
    await mac.appIcon("/Applications/Example.app", config.agentBubbleAppIconSize);
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
    const microphone = mac.microphone(() => {});
    microphone({ type: "prepare" });
    microphone({ type: "start", session: 1 });
    microphone({ type: "stop", session: 1 });

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

  /** The helper's drawn icon reaches the bubble's `<img>` as a PNG data URL; no icon, none. */
  test("an app's icon comes back as a PNG data URL, or null", async () => {
    const calls: { method: string; params: unknown }[] = [];
    let png: string | null = "iVBORw0KGgo=";
    const helper = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return { png };
      },
    } as unknown as HelperClient;
    const mac = new MacSystem(helper);

    expect(await mac.appIcon("/Applications/Example.app", 32)).toBe("data:image/png;base64,iVBORw0KGgo=");
    png = null;
    expect(await mac.appIcon("/Applications/Example.app", 32)).toBeNull();
    expect(calls).toEqual([
      { method: "appIcon", params: { path: "/Applications/Example.app", pixels: 32 } },
      { method: "appIcon", params: { path: "/Applications/Example.app", pixels: 32 } },
    ]);
  });

  /** The microphone's start carries the recording rate and waits the microphone's own start timeout;
   * its answer, or its failure, is that session's report; each chunk event the helper sends (named
   * as `MacService.microphoneChunkEvent`, its fields as `MicrophoneChunkEventTests` pins them)
   * becomes that session's samples, and a malformed one is dropped. */
  test("the microphone's commands and events cross the wire as the helper sends and reads them", async () => {
    const calls: { method: string; params: unknown; timeout: unknown }[] = [];
    const events = new Map<string, (message: Record<string, unknown>) => void>();
    let refuse = false;
    const helper = {
      request: async (method: string, params?: unknown, timeout?: unknown) => {
        calls.push({ method, params, timeout });
        if (refuse) throw new Error("microphone: noInputDevice");
        return {};
      },
      on: (event: string, handler: (message: Record<string, unknown>) => void) => events.set(event, handler),
    } as unknown as HelperClient;
    const reports: AudioReport[] = [];
    const microphone = new MacSystem(helper).microphone((report) => reports.push(report));

    microphone({ type: "start", session: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const samples = new Float32Array([0.25, -0.5, 1]);
    const emitted = /microphoneChunkEvent = "(\w+)"/.exec(readFileSync(join(root, "native/macos/Sources/VoiceMacOSKit/MacService.swift"), "utf8"));
    const chunkEvent = events.get(emitted?.[1] ?? "");
    chunkEvent?.({ event: emitted?.[1], session: 3, samples: Buffer.from(samples.buffer).toString("base64") });
    chunkEvent?.({ event: emitted?.[1], session: 3, samples: Buffer.from([1, 2, 3]).toString("base64") });
    chunkEvent?.({ event: emitted?.[1], session: "3", samples: Buffer.from(samples.buffer).toString("base64") });
    const lostName = /microphoneLostEvent = "(\w+)"/.exec(readFileSync(join(root, "native/macos/Sources/VoiceMacOSKit/MacService.swift"), "utf8"))?.[1] ?? "";
    events.get(lostName)?.({ event: lostName, session: "3" });
    events.get(lostName)?.({ event: lostName, session: 3 });
    refuse = true;
    microphone({ type: "start", session: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    microphone({ type: "stop", session: 4 });

    expect(calls).toEqual([
      { method: "microphoneStart", params: { session: 3, sampleRate: config.recordingSampleRate }, timeout: config.microphoneStartTimeout },
      { method: "microphoneStart", params: { session: 4, sampleRate: config.recordingSampleRate }, timeout: config.microphoneStartTimeout },
      { method: "microphoneStop", params: { session: 4 }, timeout: undefined },
    ]);
    expect(reports).toEqual([
      { type: "started", session: 3 },
      { type: "chunk", session: 3, samples },
      { type: "lost", session: 3 },
      { type: "failed", session: 4, error: "Error" },
    ]);
  });

  test("a chunk's samples decode from base64 little-endian floats, and a torn one does not", () => {
    const samples = new Float32Array([0, 0.125, -1]);
    expect(decodeSamples(Buffer.from(samples.buffer).toString("base64"))).toEqual(samples);
    expect(decodeSamples(Buffer.from([0, 0, 0]).toString("base64"))).toBeNull();
    expect(decodeSamples(12)).toBeNull();
  });

  /** The gesture's actions, which voice-hotkey sends by their Swift names, are the ones the app
   * takes (`hotkeyActions`): one missing there is dropped at the wire as unknown. */
  test("every gesture action voice-hotkey sends is one the app takes", () => {
    const source = readFileSync(join(root, "native/macos/Sources/VoiceHotkeyKit/PushToTalkGesture.swift"), "utf8");
    const actionEnum = /enum Action[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? "";
    const cases = [...actionEnum.matchAll(/^\s*case (\w+)/gm)].map((match) => match[1]);
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases)).toEqual(new Set(hotkeyActions));
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
