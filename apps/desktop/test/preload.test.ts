// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeAll, describe, expect, test, vi } from "vitest";
import { channels, type VoiceBridge } from "../src/shared/ipc.js";

/** Electron's renderer side, in memory: the bridge the preload exposes, the listeners it adds, and
 * each state request it makes, answered when the test says. */
const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const state = {
    exposed: null as unknown,
    listeners,
    replies: [] as ((state: unknown) => void)[],
    push(channel: string, ...args: unknown[]): void {
      for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
    },
  };
  return {
    state,
    contextBridge: {
      exposeInMainWorld: (_key: string, api: unknown) => {
        state.exposed = api;
      },
    },
    ipcRenderer: {
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)?.add(listener);
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(listener);
      },
      invoke: (channel: string) => (channel === "voice:get-state" ? new Promise((resolve) => state.replies.push(resolve)) : Promise.resolve({ error: null })),
      send: () => {},
    },
  };
});
vi.mock("electron", () => ({ contextBridge: electron.contextBridge, ipcRenderer: electron.ipcRenderer }));

let bridge: VoiceBridge;
beforeAll(async () => {
  await import("../src/preload/preload.js");
  bridge = electron.state.exposed as VoiceBridge;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("preload bridge", () => {
  /** The state asked for as the window opens can arrive after one the main process pushed since:
   * the older one never replaces the newer. */
  test("a state pushed before the first one arrives is kept", async () => {
    const seen: unknown[] = [];
    const stop = bridge.onState("overlay", (state) => seen.push(state));

    electron.state.push(channels.state, "overlay", { revision: 2 });
    electron.state.replies.shift()?.({ revision: 1 });
    await settle();

    expect(seen).toEqual([{ revision: 2 }]);
    stop();
  });

  test("the first state arrives when nothing was pushed before it, then every push", async () => {
    const seen: unknown[] = [];
    const stop = bridge.onState("overlay", (state) => seen.push(state));

    electron.state.replies.shift()?.({ revision: 1 });
    await settle();
    electron.state.push(channels.state, "settings", { other: true });
    electron.state.push(channels.state, "overlay", { revision: 2 });

    expect(seen).toEqual([{ revision: 1 }, { revision: 2 }]);
    stop();
  });

  test("a listener stopped hears nothing more, the first state included", async () => {
    const seen: unknown[] = [];
    const stop = bridge.onState("overlay", (state) => seen.push(state));

    stop();
    electron.state.replies.shift()?.({ revision: 1 });
    await settle();
    electron.state.push(channels.state, "overlay", { revision: 2 });

    expect(seen).toEqual([]);
  });
});
