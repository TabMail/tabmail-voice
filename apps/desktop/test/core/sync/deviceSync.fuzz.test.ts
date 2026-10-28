// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { extractBullets, extractSection, replaceSection } from "../../../src/core/personalization/bulletMerge.js";
import { defaultComposition, defaultKnowledgeBase } from "../../../src/core/personalization/defaults.js";
import { MemoryStore, type StoreProblem } from "../../../src/core/util/keyValueStore.js";
import { FakeRelay, ThunderbirdPeer, VoiceDevice } from "../../support/fakeDeviceSync.js";

/**
 * Randomized orderings of Device Sync between Voice and a peer run by Thunderbird's rules: edits,
 * removals, resets, a factory reset, disconnections, probes, the passing of time and the relay's
 * delivery, interleaved by a seeded generator. At the end, connected and settled, every bullet either
 * device ever held is on both unless a user removed it (a reset counts as removing what only the
 * resetting device held), and the two differ at most in bullets a user removed. A person acts at least
 * a millisecond apart from their device's last message, and confirms a reset after what was in flight
 * has arrived. A failure names its seed; `DEVICE_SYNC_FUZZ_SEEDS` runs more of them.
 */

const seeds = Number(process.env.DEVICE_SYNC_FUZZ_SEEDS ?? 2_000);
const steps = 80;
const sections = ["General writing style", "Language"] as const;

/** A store whose file can be made unreadable, for the factory reset. */
class ResettableStore extends MemoryStore {
  problem: StoreProblem | undefined;

  override set(key: string, value: unknown): boolean {
    return this.problem === undefined && super.set(key, value);
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    return this.problem === undefined && super.setAll(values);
  }

  clear(): void {
    for (const key of Object.keys(this.snapshot())) this.values.delete(key);
  }
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Where = "kb" | (typeof sections)[number];
const places: readonly Where[] = ["kb", ...sections];

function bulletsIn(where: Where, text: { kb: string; composition: string }): string[] {
  return where === "kb" ? extractBullets(text.kb) : extractBullets(extractSection(text.composition, where));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now());
});

afterEach(() => {
  vi.useRealTimers();
});

test(`${seeds} seeded orderings: no bullet lost without a user removal, and every other reaches both devices`, { timeout: 600_000 }, async () => {
  for (let seed = 1; seed <= seeds; seed += 1) {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T | undefined => values[Math.floor(next() * values.length)];
    const relay = new FakeRelay();
    let counter = 0;
    const fresh = (who: string) => `${who} bullet ${seed}-${(counter += 1)}`;

    // The peer starts customised, or at its defaults; Voice with what PR 2 left (no sync times), or fresh.
    const peerTexts = next() < 0.7 ? { kb: `${defaultKnowledgeBase}\n- ${fresh("Peer")}`, composition: replaceSection(defaultComposition, "Language", `- ${fresh("Peer")}`) } : {};
    const peer = new ThunderbirdPeer(relay, "thunderbird", peerTexts);
    const store = new ResettableStore(next() < 0.5 ? { "user_prompts:user_kb.md": `${defaultKnowledgeBase}\n- ${fresh("Voice")}` } : {});
    const voice = new VoiceDevice(relay, store);
    const voiceText = () => ({ kb: voice.prompts.knowledgeBase, composition: voice.prompts.composition });
    const peerText = () => ({ kb: peer.fields.kb.text, composition: peer.fields.composition.text });

    const seen = new Set<string>();
    const removed = new Set<string>();
    const note = () => {
      for (const where of places) for (const bullet of [...bulletsIn(where, voiceText()), ...bulletsIn(where, peerText())]) seen.add(`${where}|${bullet}`);
    };
    /** Voice's reset of `where` drops what only Voice held. */
    const resetDrops = (where: Where) => {
      const peerHas = new Set(bulletsIn(where, peerText()));
      for (const bullet of bulletsIn(where, voiceText())) if (!peerHas.has(bullet)) removed.add(`${where}|${bullet}`);
    };
    note();
    // The peer's own style replaced the default's Language bullet: its user removed that.
    for (const where of places) {
      const onPeer = new Set(bulletsIn(where, peerText()));
      for (const bullet of bulletsIn(where, { kb: defaultKnowledgeBase, composition: defaultComposition })) if (!onPeer.has(bullet)) removed.add(`${where}|${bullet}`);
    }
    if (next() < 0.5) peer.connect();
    voice.sync.update();

    const trace: string[] = [];
    for (let step = 0; step < steps; step += 1) {
      const where = pick(places) ?? "kb";
      const roll = next();
      // A person edits at least a millisecond after what their device last did: two texts of one
      // device never share a time but through a merge.
      if (roll >= 0.4 && roll < 0.77) await vi.advanceTimersByTimeAsync(1);
      if (roll < 0.3) {
        const name = pick(relay.waiting());
        trace.push(`deliver ${name}`);
        if (name !== undefined) relay.deliverOne(name);
      } else if (roll < 0.4) {
        const ms = Math.floor(next() * 1_500) + 1;
        trace.push(`wait ${ms}`);
        await vi.advanceTimersByTimeAsync(ms);
      } else if (roll < 0.5) {
        const bullet = fresh("Voice");
        trace.push(`voice add ${where}`);
        if (where === "kb") voice.addKB(bullet);
        else voice.addStyle(where, bullet);
      } else if (roll < 0.6) {
        const bullet = fresh("Peer");
        trace.push(`peer add ${where}`);
        if (where === "kb") peer.addKB(bullet);
        else peer.addStyle(where, bullet);
      } else if (roll < 0.66) {
        const bullet = pick(bulletsIn(where, voiceText()));
        trace.push(`voice remove ${where}`);
        if (bullet !== undefined) {
          removed.add(`${where}|${bullet}`);
          if (where === "kb") voice.removeKB(bullet);
          else voice.removeStyle(where, bullet);
        }
      } else if (roll < 0.72) {
        const bullet = pick(bulletsIn(where, peerText()));
        trace.push(`peer remove ${where}`);
        if (bullet !== undefined) {
          removed.add(`${where}|${bullet}`);
          if (where === "kb") peer.removeKB(bullet);
          else peer.removeStyle(where, bullet);
        }
      } else if (roll < 0.75) {
        // A reset waits for the user's confirmation, longer than anything takes in flight.
        await relay.settle();
        trace.push(`voice reset ${where === "kb" ? "kb" : "composition"}`);
        if (where === "kb") {
          resetDrops("kb");
          voice.prompts.resetKnowledgeBase();
        } else {
          for (const section of sections) resetDrops(section);
          voice.prompts.resetComposition();
        }
      } else if (roll < 0.77) {
        await relay.settle();
        trace.push("voice factory reset");
        for (const place of places) resetDrops(place);
        store.problem = { kind: "damaged", path: "/tmp/example/userPrompts.json", code: "invalid" };
        voice.sync.update();
        voice.prompts.resetFile(() => {
          store.clear();
          store.problem = undefined;
        });
      } else if (roll < 0.82) {
        voice.allowed = !voice.allowed;
        trace.push(`voice sync ${voice.allowed ? "on" : "off"}`);
        voice.sync.update();
      } else if (roll < 0.87) {
        trace.push(relay.isConnected("thunderbird") ? "peer disconnects" : "peer connects");
        if (relay.isConnected("thunderbird")) peer.disconnect();
        else peer.connect();
      } else if (roll < 0.9) {
        trace.push("voice connection drops");
        relay.close("voice", 1006);
      } else if (roll < 0.95) {
        trace.push("peer probes");
        peer.probe();
      } else {
        trace.push("voice wakes");
        voice.sync.wake();
      }
      note();
    }

    // Everyone back, and two rounds of probes each way.
    voice.allowed = true;
    voice.sync.wake();
    if (!relay.isConnected("thunderbird")) peer.connect();
    await relay.settle();
    for (let round = 0; round < 2; round += 1) {
      peer.probe();
      await relay.settle();
      await vi.advanceTimersByTimeAsync(config.deviceSyncProbeInterval);
      await relay.settle();
    }
    note();

    const context = `seed ${seed}: ${trace.join(", ")}`;
    for (const where of places) {
      const onVoice = new Set(bulletsIn(where, voiceText()));
      const onPeer = new Set(bulletsIn(where, peerText()));
      // A bullet removed on one device may stay on the other: neither can tell a removal from a bullet
      // never received, and keeping it is the side that loses nothing.
      const differ = [...onVoice].filter((bullet) => !onPeer.has(bullet)).concat([...onPeer].filter((bullet) => !onVoice.has(bullet)));
      expect(differ.filter((bullet) => !removed.has(`${where}|${bullet}`)), `${context}\n${where} converges`).toEqual([]);
      const kept = [...seen].filter((key) => key.startsWith(`${where}|`) && !removed.has(key)).map((key) => key.slice(where.length + 1));
      expect([...onPeer].sort(), `${context}\n${where} keeps every bullet no user removed`).toEqual(expect.arrayContaining(kept));
    }
    voice.sync.stop();
  }
});
