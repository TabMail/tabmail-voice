// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { configureLog, type LogLevel } from "../../../src/core/log.js";
import { extractBullets, extractSection, replaceSection } from "../../../src/core/personalization/bulletMerge.js";
import { defaultComposition, defaultKnowledgeBase } from "../../../src/core/personalization/defaults.js";
import type { PromptField } from "../../../src/core/personalization/prompts.js";
import { ancestorTime, epochZero } from "../../../src/core/sync/time.js";
import { MemoryStore, type StoreProblem } from "../../../src/core/util/keyValueStore.js";
import { FakeRelay, ThunderbirdPeer, VoiceDevice } from "../../support/fakeDeviceSync.js";
import { Fixtures } from "../../support/stubs.js";

const style = "General writing style";
const language = "Language";
const kbKey = "user_prompts:user_kb.md";

const peerKB = ["- Peer fact one", "- Peer fact two", "- Peer fact three"].join("\n");
const peerStyle = replaceSection(defaultComposition, style, ["- Peer style one", "- Peer style two"].join("\n"));

/** A store whose file couldn't be read at launch: every write fails, as `JSONFileStore`'s. */
class UnreadableStore extends MemoryStore {
  problem: StoreProblem | undefined = { kind: "damaged", path: "/tmp/example/userPrompts.json", code: "invalid" };

  override set(key: string, value: unknown): boolean {
    return this.problem === undefined && super.set(key, value);
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    return this.problem === undefined && super.setAll(values);
  }
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Every bullet in `texts`' knowledge bases, and in the writing style's sections. */
function bulletsOf(field: PromptField, text: string): string[] {
  return field === "kb" ? extractBullets(text) : [style, language].flatMap((section) => extractBullets(extractSection(text, section)));
}

/** No `prompt_state` Voice sent with a time a peer would act on left out any of `bullets`: whatever
 * the peer then did with it, it removed none of them. */
function sentNothingWithout(relay: FakeRelay, field: PromptField, bullets: readonly string[]): void {
  for (const message of relay.messages("voice", "prompt_state")) {
    const data = message.data as Record<string, string>;
    const text = data[field];
    if (text === undefined || data[`${field}_updated_at`] === epochZero) continue;
    expect(bulletsOf(field, text)).toEqual(expect.arrayContaining([...bullets]));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Voice joining never wipes another device's texts", () => {
  test("a fresh Voice takes the peer's texts and sends nothing that removes one of its bullets", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB, composition: peerStyle });
    peer.connect();
    await relay.settle();

    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();

    expect(voice.kb).toEqual(extractBullets(peerKB));
    expect(voice.section(style)).toEqual(["Peer style one", "Peer style two"]);
    expect(peer.fields.kb.text).toBe(peerKB);
    expect(peer.fields.composition.text).toBe(peerStyle);
    sentNothingWithout(relay, "kb", extractBullets(peerKB));
    sentNothingWithout(relay, "composition", ["Peer style one", "Peer style two"]);
  });

  test("Voice's edits made before its first sync reach a peer that keeps every bullet of its own", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB, composition: peerStyle });
    // Synced with another device before: its text is its peer base, so a newer text would fast-forward it.
    for (const field of ["kb", "composition"] as const) peer.fields[field] = { ...peer.fields[field], peerBase: peer.fields[field].text, peerBaseTime: peer.fields[field].time };
    peer.connect();
    await relay.settle();
    vi.advanceTimersByTime(1_000);

    // As PR 2 left them, with no sync time, then a kb_add and a Settings edit of this release, stamped.
    const store = new MemoryStore({ [kbKey]: `${defaultKnowledgeBase}\n- Voice fact before sync` });
    const voice = new VoiceDevice(relay, store);
    voice.allowed = false;
    voice.addKB("Voice fact from kb_add");
    voice.addStyle(language, "Voice style from Settings");
    voice.allowed = true;
    voice.sync.update();
    await relay.settle();

    const kb = sorted([...extractBullets(peerKB), "Voice fact before sync", "Voice fact from kb_add"]);
    expect(sorted(peer.kb)).toEqual(kb);
    expect(sorted(voice.kb)).toEqual(kb);
    expect(peer.section(style)).toEqual(["Peer style one", "Peer style two"]);
    expect(sorted(peer.section(language))).toEqual(sorted([...extractBullets(extractSection(defaultComposition, language)), "Voice style from Settings"]));
    expect(sorted(voice.section(style))).toEqual(sorted(peer.section(style)));
    sentNothingWithout(relay, "kb", extractBullets(peerKB));
  });

  test("two peers in step both keep their bullets and get Voice's", async () => {
    const relay = new FakeRelay();
    const thunderbird = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    const iOS = new ThunderbirdPeer(relay, "ios", { kb: peerKB });
    for (const peer of [thunderbird, iOS]) peer.fields.kb = { ...peer.fields.kb, peerBase: peerKB, peerBaseTime: peer.fields.kb.time };
    thunderbird.connect();
    iOS.connect();
    await relay.settle();

    const voice = new VoiceDevice(relay, new MemoryStore({ [kbKey]: "- Voice fact" }));
    voice.sync.update();
    await relay.settle();

    const kb = sorted([...extractBullets(peerKB), "Voice fact"]);
    expect(sorted(thunderbird.kb)).toEqual(kb);
    expect(sorted(iOS.kb)).toEqual(kb);
    expect(sorted(voice.kb)).toEqual(kb);
  });

  test("a text never synced here is answered with epoch zero, which a peer never takes over its own", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay, new MemoryStore({ [kbKey]: "- Voice fact" }));
    voice.addKB("Voice fact stamped");
    voice.sync.update();
    await relay.settle();

    // Joins after Voice, so Voice's own ask went to no one; its probe asks Voice first.
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.fields.kb = { ...peer.fields.kb, peerBase: peerKB, peerBaseTime: peer.fields.kb.time };
    relay.join(peer);
    peer.probe();
    relay.deliverOne("voice");
    relay.deliverOne("thunderbird");

    expect(peer.kb).toEqual(extractBullets(peerKB));
    const [answer] = relay.messages("voice", "prompt_state");
    expect((answer?.data as Record<string, string>).kb_updated_at).toBe(epochZero);
  });

  test("a peer's default or reset text, at epoch zero, is merged in and Voice's own text is sent on", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay);
    peer.connect();
    await relay.settle();

    const voice = new VoiceDevice(relay, new MemoryStore({ [kbKey]: `${defaultKnowledgeBase}\n- Voice fact` }));
    voice.sync.update();
    await relay.settle();

    expect(peer.kb).toEqual([...extractBullets(defaultKnowledgeBase), "Voice fact"]);
    expect(voice.kb).toEqual(peer.kb);
  });

  test("Reset on Voice takes the peer's copy back, and the peer keeps it", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    vi.advanceTimersByTime(1_000);

    voice.prompts.resetKnowledgeBase();
    expect(voice.kb).toEqual(extractBullets(defaultKnowledgeBase));
    await relay.settle();

    expect(voice.kb).toEqual(extractBullets(peerKB));
    expect(peer.fields.kb.text).toBe(peerKB);
    expect(relay.messages("voice", "request_state").at(-1)).toEqual({ type: "request_state", fields: ["kb"] });
  });

  test("another account's texts go back to the defaults, nothing of them is sent, and the account's own are taken", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    await relay.settle();
    const store = new MemoryStore({
      [kbKey]: "- Other account fact",
      prompt_history: [{ id: "a", timestamp: new Date().toISOString(), source: "reset", fields: ["kb"], composition: "", kb: "- Other account fact" }],
      "device_sync_ts:kb": new Date().toISOString(),
      "device_peer_base:kb": "- Other account fact",
      "device_peer_base_ts:kb": new Date().toISOString(),
      device_sync_owner_user_id: "user-0",
    });

    const voice = new VoiceDevice(relay, store);
    voice.sync.update();
    expect(voice.kb).toEqual(extractBullets(defaultKnowledgeBase));
    expect(voice.prompts.history).toEqual([]);
    expect(voice.prompts.owner).toBe(Fixtures.userID);
    await relay.settle();

    expect(voice.kb).toEqual(extractBullets(peerKB));
    expect(relay.sent.some((entry) => entry.text.includes("Other account fact"))).toBe(false);
  });

  test("another account signing in while connected reconnects for it, its texts at their defaults", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay, new MemoryStore({ [kbKey]: "- First account fact" }));
    voice.sync.update();
    await relay.settle();
    expect(relay.urls).toHaveLength(1);

    voice.account.signOut();
    await relay.settle();
    expect(relay.isConnected("voice")).toBe(false);
    expect(voice.kb).toEqual(["First account fact"]);

    // Signed in again as another account: the texts were the first one's.
    (voice.account as unknown as { set(session: unknown): void }).set(Fixtures.session({ userID: "user-2" }));
    await relay.settle();
    expect(voice.prompts.owner).toBe("user-2");
    expect(voice.kb).toEqual(extractBullets(defaultKnowledgeBase));
    expect(relay.urls).toHaveLength(2);
    expect(relay.isConnected("voice")).toBe(true);
  });
});

describe("knowledge base entries merge, never lost, never wiped", () => {
  async function synced(): Promise<{ relay: FakeRelay; peer: ThunderbirdPeer; voice: VoiceDevice }> {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    vi.advanceTimersByTime(1_000);
    return { relay, peer, voice };
  }

  test("an entry added before the first sync, then a peer with entries: both sets on both devices", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    await relay.settle();
    const voice = new VoiceDevice(relay);
    voice.allowed = false;
    voice.addKB("Voice fact");
    voice.allowed = true;
    voice.sync.update();
    await relay.settle();

    const kb = sorted([...extractBullets(defaultKnowledgeBase), ...extractBullets(peerKB), "Voice fact"].filter((bullet) => peer.kb.includes(bullet) || bullet === "Voice fact"));
    expect(sorted(peer.kb)).toEqual(sorted([...extractBullets(peerKB), "Voice fact"]));
    expect(sorted(voice.kb)).toEqual(kb);
  });

  test("an entry added while the first answer is on its way survives and is sent on", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    await relay.settle();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await vi.advanceTimersByTimeAsync(0);
    relay.deliverOne("voice"); // connected: Voice asks
    relay.deliverOne("thunderbird"); // the peer answers; the answer waits for Voice
    voice.addKB("Voice fact in flight");
    await relay.settle();

    expect(sorted(voice.kb)).toEqual(sorted([...extractBullets(peerKB), "Voice fact in flight"]));
    expect(sorted(peer.kb)).toEqual(sorted(voice.kb));
  });

  test("an entry added or edited while a synced peer's change is on its way survives and syncs next", async () => {
    const { relay, peer, voice } = await synced();
    peer.addKB("Peer fact new");
    voice.addKB("Voice fact new");
    voice.removeKB("Peer fact one");
    await relay.settle();

    const kb = sorted(["Peer fact two", "Peer fact three", "Peer fact new", "Voice fact new"]);
    expect(sorted(voice.kb)).toEqual(kb);
    expect(sorted(peer.kb)).toEqual(kb);
  });

  test("concurrent adds on Voice and a peer are both kept", async () => {
    const { relay, peer, voice } = await synced();
    voice.addKB("Voice fact A");
    await vi.advanceTimersByTimeAsync(config.deviceSyncSendDelay);
    peer.addKB("Peer fact A");
    await relay.settle();

    const kb = sorted([...extractBullets(peerKB), "Voice fact A", "Peer fact A"]);
    expect(sorted(voice.kb)).toEqual(kb);
    expect(sorted(peer.kb)).toEqual(kb);
  });

  test("after a factory reset Voice takes the peer's entries, adds after it merge as adds, and the peer is never emptied", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB, composition: peerStyle });
    peer.connect();
    await relay.settle();
    const store = new UnreadableStore();
    const voice = new VoiceDevice(relay, store);
    voice.sync.update();
    await relay.settle();
    expect(relay.urls).toEqual([]);

    voice.prompts.resetFile(() => {
      store.problem = undefined;
    });
    await vi.advanceTimersByTimeAsync(0);
    relay.deliverOne("voice"); // connected: Voice asks
    voice.addKB("Voice fact after reset");
    await relay.settle();

    expect(sorted(peer.kb)).toEqual(sorted([...extractBullets(peerKB), "Voice fact after reset"]));
    expect(sorted(voice.kb)).toEqual(sorted(peer.kb));
    expect(peer.section(style)).toEqual(["Peer style one", "Peer style two"]);
    expect(voice.section(style)).toEqual(["Peer style one", "Peer style two"]);
    sentNothingWithout(relay, "kb", extractBullets(peerKB));
  });
});

describe("what Voice adds to the peers' rules: nothing lost, and every exchange ends", () => {
  async function synced(): Promise<{ relay: FakeRelay; peer: ThunderbirdPeer; voice: VoiceDevice }> {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    vi.advanceTimersByTime(1_000);
    return { relay, peer, voice };
  }

  /** Voice's texts, ancestors left out. */
  function textsSent(relay: FakeRelay): Record<string, string>[] {
    return relay
      .messages("voice", "prompt_state")
      .map((message) => message.data as Record<string, string>)
      .filter((data) => !Object.values(data).includes(ancestorTime));
  }

  test("a peer that never synced keeps an edit it hasn't sent yet when Voice's merge reaches it first", async () => {
    const { relay, peer, voice } = await synced();
    peer.disconnect();
    voice.addKB("Voice fact");
    await relay.settle();
    const second = new ThunderbirdPeer(relay, "thunderbird-2", { kb: `${defaultKnowledgeBase}\n- Second fact` });
    second.connect();
    relay.deliverOne("thunderbird-2"); // connected: it sends its texts
    await vi.advanceTimersByTimeAsync(1);
    second.addKB("Second fact later"); // waits out Thunderbird's broadcast delay
    await vi.advanceTimersByTimeAsync(100);
    relay.deliverOne("voice"); // Voice merges, and sends the merge back
    await relay.settle();

    expect(second.kb).toEqual(expect.arrayContaining(["Second fact", "Second fact later", "Voice fact"]));
    expect(sorted(voice.kb)).toEqual(sorted(second.kb));
  });

  test("a bullet the peer removes after taking Voice's edit is removed on Voice too, and stays removed", async () => {
    const { relay, peer, voice } = await synced();
    voice.addKB("Voice fact");
    await relay.settle();
    expect(peer.kb).toContain("Voice fact");
    vi.advanceTimersByTime(1_000);
    peer.removeKB("Voice fact");
    await relay.settle();

    expect(voice.kb).not.toContain("Voice fact");
    expect(peer.kb).not.toContain("Voice fact");
  });

  test("a bullet the peer removes after taking Voice's merge is removed on Voice too, and stays removed", async () => {
    const { relay, peer, voice } = await synced();
    peer.disconnect();
    voice.addKB("Voice fact offline");
    await relay.settle();
    vi.advanceTimersByTime(1_000);
    peer.connect(); // sends its texts, which Voice's edit never reached
    await relay.settle();
    expect(peer.kb).toContain("Voice fact offline");
    vi.advanceTimersByTime(1_000);
    peer.removeKB("Voice fact offline");
    await relay.settle();

    expect(voice.kb).not.toContain("Voice fact offline");
    expect(peer.kb).not.toContain("Voice fact offline");
  });

  test("a text sent again and again without Voice's bullets gets the merge back once until the next probe", async () => {
    const { relay, peer, voice } = await synced();
    const old = JSON.stringify({ type: "prompt_state", data: { kb: peerKB, kb_updated_at: peer.fields.kb.time } });
    voice.addKB("Voice fact");
    await relay.settle();
    relay.sent.length = 0;
    for (let copy = 0; copy < 3; copy += 1) relay.send(peer, old);
    await relay.settle();
    expect(textsSent(relay)).toEqual([{ kb: voice.prompts.knowledgeBase, kb_updated_at: voice.prompts.syncState("kb").time }]);

    for (let waited = 0; waited < config.deviceSyncProbeInterval; waited += config.deviceSyncPingInterval) {
      await vi.advanceTimersByTimeAsync(config.deviceSyncPingInterval);
      await relay.settle();
    }
    relay.sent.length = 0;
    relay.send(peer, old);
    await relay.settle();
    expect(textsSent(relay)).toHaveLength(1);
  });

  test("a different text with the time of the last one received is merged, not skipped", async () => {
    const { relay, peer, voice } = await synced();
    relay.send(peer, JSON.stringify({ type: "prompt_state", data: { kb: `${peerKB}\n- Same time fact`, kb_updated_at: peer.fields.kb.time } }));
    await relay.settle();

    expect(sorted(voice.kb)).toEqual(sorted([...extractBullets(peerKB), "Same time fact"]));
  });

  test("another computer's merge ancestor changes nothing here and gets no answer", async () => {
    const { relay, peer, voice } = await synced();
    voice.addKB("Voice fact");
    await relay.settle();
    relay.sent.length = 0;
    const before = voice.prompts.knowledgeBase;
    relay.send(peer, JSON.stringify({ type: "prompt_state", data: { kb: "- Ancestor fact", kb_updated_at: ancestorTime } }));
    await relay.settle();

    expect(voice.prompts.knowledgeBase).toBe(before);
    expect(relay.messages("voice", "prompt_state")).toEqual([]);
  });
});

describe("when sync runs", () => {
  test("while the settings file can't be read (sync not allowed), nothing is sent and nothing is taken", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    const voice = new VoiceDevice(relay, new MemoryStore({ [kbKey]: "- Voice fact" }));
    voice.allowed = false;
    voice.sync.update();
    peer.addKB("Peer fact new");
    voice.addKB("Voice fact new");
    await relay.settle();

    expect(relay.urls).toEqual([]);
    expect(relay.sent.filter((entry) => entry.from === "voice")).toEqual([]);
    expect(voice.kb).toEqual(["Voice fact", "Voice fact new"]);

    voice.allowed = true;
    voice.sync.update();
    await relay.settle();
    expect(sorted(voice.kb)).toEqual(sorted([...extractBullets(peerKB), "Peer fact new", "Voice fact", "Voice fact new"]));
  });

  test("while the texts' file can't be read, sync doesn't connect", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay, new UnreadableStore());
    voice.sync.update();
    await relay.settle();
    expect(relay.urls).toEqual([]);
  });

  test("turned off, it disconnects; the edits made meanwhile reach the peer once it is back on", async () => {
    const relay = new FakeRelay();
    const peer = new ThunderbirdPeer(relay, "thunderbird", { kb: peerKB });
    peer.connect();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();

    voice.allowed = false;
    voice.sync.update();
    expect(relay.isConnected("voice")).toBe(false);
    vi.advanceTimersByTime(1_000);
    voice.addKB("Voice fact while off");
    await relay.settle();
    expect(peer.kb).toEqual(extractBullets(peerKB));

    voice.allowed = true;
    voice.sync.update();
    await relay.settle();
    expect(sorted(peer.kb)).toEqual(sorted([...extractBullets(peerKB), "Voice fact while off"]));
  });

  test("debug mode switching the relay connects to the other one, and back", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    voice.url = config.deviceSyncDevelopmentURL;
    voice.sync.update();
    await relay.settle();
    voice.url = config.deviceSyncURL;
    voice.sync.update();
    await relay.settle();

    expect(relay.urls.map((url) => url.split("?")[0])).toEqual([config.deviceSyncURL, config.deviceSyncDevelopmentURL, config.deviceSyncURL]);
    expect(relay.isConnected("voice")).toBe(true);
  });

  test("the token goes in the address, and a sign-out disconnects", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    expect(relay.urls).toEqual([`${config.deviceSyncURL}?token=access-1`]);

    voice.account.signOut();
    expect(relay.isConnected("voice")).toBe(false);
  });
});

describe("the relay's messages", () => {
  async function connected(): Promise<{ relay: FakeRelay; voice: VoiceDevice; peer: ThunderbirdPeer }> {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    const peer = new ThunderbirdPeer(relay);
    voice.sync.update();
    peer.connect();
    await relay.settle();
    relay.sent.length = 0;
    return { relay, voice, peer };
  }

  test("an AI cache probe is answered at once, with nothing, under its id", async () => {
    const { relay, peer } = await connected();
    relay.send(peer, JSON.stringify({ type: "ai_cache_probe", keys: ["message-1"], probeId: "probe-1" }));
    relay.send(peer, JSON.stringify({ type: "ai_cache_probe", keys: ["message-2"] }));
    relay.deliverOne("voice");
    relay.deliverOne("voice");

    expect(relay.messages("voice", "ai_cache_response")).toEqual([{ type: "ai_cache_response", results: {}, probeId: "probe-1" }]);
  });

  test("a request for both texts, for one, or for neither, is answered with what was asked, each after its ancestor", async () => {
    const { relay, peer } = await connected();
    const answers = () =>
      relay.messages("voice", "prompt_state").map((message) => {
        const data = message.data as Record<string, string>;
        return `${Object.values(data).includes(ancestorTime) ? "ancestor" : "text"}: ${Object.keys(data).sort().join(" ")}`;
      });
    for (const fields of [undefined, [], ["kb"], ["templates"]]) relay.send(peer, JSON.stringify({ type: "request_state", ...(fields ? { fields } : {}) }));
    await relay.settle();

    const both = ["ancestor: composition composition_updated_at", "ancestor: kb kb_updated_at", "text: composition composition_updated_at kb kb_updated_at"];
    expect(answers()).toEqual([...both, ...both, "ancestor: kb kb_updated_at", "text: kb kb_updated_at"]);
  });

  test("what Voice sends holds only the knowledge base and the writing style, with their times, after the last text the peer sent", async () => {
    const { relay, voice, peer } = await connected();
    const peerText = peer.fields.kb.text;
    voice.addKB("Voice fact");
    await relay.settle();

    expect(relay.messages("voice", "prompt_state").slice(0, 2)).toEqual([
      { type: "prompt_state", data: { kb: peerText, kb_updated_at: ancestorTime } },
      { type: "prompt_state", data: { kb: `${peerText}\n- Voice fact`, kb_updated_at: voice.prompts.syncState("kb").time } },
    ]);
  });

  test("a change taken from a peer isn't sent back to it, nor recorded as an edit", async () => {
    const { relay, voice, peer } = await connected();
    peer.addKB("Peer fact");
    await relay.settle();

    expect(voice.kb).toContain("Peer fact");
    expect(relay.messages("voice", "prompt_state")).toEqual([]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(voice.prompts.history.map((entry) => entry.source)).toEqual(["sync_receive"]);
  });

  test("ignores what isn't for it: an action rule, a stale or malformed time, a message that isn't JSON", async () => {
    const { relay, voice, peer } = await connected();
    const before = voice.prompts.knowledgeBase;
    relay.send(peer, JSON.stringify({ type: "prompt_state", data: { action: "- Example rule", action_updated_at: new Date().toISOString() } }));
    relay.send(peer, JSON.stringify({ type: "prompt_state", data: { kb: "- Wrong time", kb_updated_at: "yesterday" } }));
    relay.send(peer, JSON.stringify({ type: "prompt_state", data: { kb: "- Old fact", kb_updated_at: peer.fields.kb.time } }));
    relay.send(peer, JSON.stringify({ type: "prompt_state", data: "- Not an object" }));
    relay.inject("voice", JSON.stringify({ type: "request_state", fields: ["kb"] }).replace("}", ""));
    await relay.settle();

    expect(voice.prompts.knowledgeBase).toBe(before);
  });
});

describe("the relay's size", () => {
  test("texts over it aren't sent, the error is logged with sizes only and shown, and cleared once they fit", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    const peer = new ThunderbirdPeer(relay);
    voice.sync.update();
    peer.connect();
    await relay.settle();
    relay.sent.length = 0;
    const errors: string[] = [];
    const lines: [LogLevel, string][] = [];
    configureLog({ isDebugBuild: true, sinks: { file: (level, text) => lines.push([level, text]), error: (text) => errors.push(text) } });
    let changes = 0;
    voice.sync.observe(() => (changes += 1));

    const large = "Large fact ".repeat(config.deviceSyncMessageMaxBytes / 10);
    voice.addKB(large);
    await relay.settle();

    expect(relay.messages("voice", "prompt_state")).toEqual([]);
    expect(voice.sync.tooLarge).toBe(true);
    expect(changes).toBe(1);
    expect(errors).toEqual([expect.stringMatching(/^DeviceSync: kb not sent: \d+ bytes, over the relay's 131072$/)]);
    expect(lines.filter(([level, text]) => level !== "CONTENT" && text.includes("Large fact"))).toEqual([]);

    voice.removeKB(large.trim());
    await relay.settle();
    expect(voice.sync.tooLarge).toBe(false);
    expect(relay.messages("voice", "prompt_state").map((message) => (message.data as Record<string, string>).kb_updated_at === ancestorTime)).toEqual([true, false]);
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
  });

  test("each ancestor goes alone: two texts that fit apart are never refused together", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    const peer = new ThunderbirdPeer(relay);
    voice.sync.update();
    peer.connect();
    await relay.settle();
    const half = config.deviceSyncMessageMaxBytes / 2 + 1_000;
    const largeKB = "Large fact ".repeat(half / 10).trim();
    peer.addKB(largeKB);
    await relay.settle();
    const largeStyle = "Large style ".repeat(half / 11).trim();
    peer.addStyle(style, largeStyle);
    await relay.settle();
    peer.disconnect();
    voice.removeKB(largeKB);
    await relay.settle();

    const second = new ThunderbirdPeer(relay, "thunderbird-2");
    second.connect(); // at its defaults: it asks for everything
    await relay.settle();
    expect(voice.sync.tooLarge).toBe(false);
    expect(second.kb).toEqual(voice.kb);
    expect(second.section(style)).toContain(largeStyle);
  });
});

describe("the connection", () => {
  test("keeps alive with the relay's exact ping, and asks the other devices for their texts every five minutes", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    const sent: string[] = [];
    const send = relay.send.bind(relay);
    relay.send = (from, text) => {
      if (from.name === "voice") sent.push(text);
      send(from, text);
    };
    voice.sync.update();
    await relay.settle();
    sent.length = 0;

    await vi.advanceTimersByTimeAsync(config.deviceSyncProbeInterval);
    expect(sent.filter((text) => text === '{"type":"ping"}')).toHaveLength(config.deviceSyncProbeInterval / config.deviceSyncPingInterval);
    expect(sent.filter((text) => text !== '{"type":"ping"}')).toEqual([JSON.stringify({ type: "request_state", fields: ["composition", "kb"] })]);
  });

  test("tries again after 5 s, doubling up to 300 s, 10 times, then waits for a wake", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    const delays: number[] = [];
    for (let attempt = 0; attempt < config.deviceSyncReconnectAttempts + 1; attempt += 1) {
      const before = relay.urls.length;
      relay.close("voice", 1006);
      let waited = 0;
      while (relay.urls.length === before && waited < 2 * config.deviceSyncReconnectMaxDelay) {
        await vi.advanceTimersByTimeAsync(1_000);
        waited += 1_000;
      }
      if (relay.urls.length === before) break;
      delays.push(waited);
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000]);

    voice.sync.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.isConnected("voice")).toBe(true);
  });

  test("an expired token reconnects at once with a refreshed one", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    const tokens = vi.spyOn(voice.account, "validToken").mockImplementation(async (force) => (force ? "access-2" : "access-1"));
    voice.sync.update();
    await relay.settle();
    relay.close("voice", 4001);
    await vi.advanceTimersByTimeAsync(0);

    expect(tokens).toHaveBeenLastCalledWith(true);
    expect(relay.urls.at(-1)).toBe(`${config.deviceSyncURL}?token=access-2`);
    expect(relay.isConnected("voice")).toBe(true);
  });

  test("a wake while connected connects afresh, and asks again", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    voice.sync.wake();
    await relay.settle();

    expect(relay.urls).toHaveLength(2);
    expect(relay.messages("voice", "request_state")).toHaveLength(2);
  });
});
