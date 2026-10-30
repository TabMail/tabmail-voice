// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { configureLog, type LogLevel } from "../../../src/core/log.js";
import { defaultCatalog, epochZero } from "../../../src/core/sync/bullets.js";
import { MemoryStore, type StoreProblem } from "../../../src/core/util/keyValueStore.js";
import { BulletDevice, BulletRelay, DeviceStore } from "../../support/bulletDevices.js";
import { FakeRelay, VoiceDevice } from "../../support/fakeDeviceSync.js";
import { Fixtures } from "../../support/stubs.js";

const peerName = "ffffffff00000001";
const kbDefaults = defaultCatalog.defaults.filter((entry) => entry.field === "kb").map((entry) => entry.text);

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

function bulletState(field: string, bullets: [string, string, string, number][], seen: Record<string, number>, snap = "0000000000000001"): string {
  return JSON.stringify({ type: "bullet_state", v: 1, field, sender: "ffffffffffffffff", snap, part: 1, parts: 1, bullets, seen });
}

/** Every type Voice sent, pings aside. */
function typesSent(relay: FakeRelay, name = "voice"): string[] {
  return [...new Set(relay.sent.filter((entry) => entry.from === name).map((entry) => (JSON.parse(entry.text) as { type: string }).type))];
}

async function connected(): Promise<{ relay: FakeRelay; voice: VoiceDevice; peer: ReturnType<FakeRelay["peer"]> }> {
  const relay = new FakeRelay();
  const peer = relay.peer("thunderbird");
  const voice = new VoiceDevice(relay);
  voice.sync.update();
  await relay.settle();
  relay.sent.length = 0;
  peer.inbox.length = 0;
  return { relay, voice, peer };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what Voice sends (DS-SEND, DS-WIRE, DS-NO-REQUEST)", () => {
  test("on connect, each field's full state, labelled; never a request or a text of the released format", async () => {
    const relay = new FakeRelay();
    const peer = relay.peer("thunderbird");
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();

    const sent = relay.messages("voice", "bullet_state");
    expect(sent.map((message) => message.field)).toEqual(["kb", "composition"]);
    const kb = sent[0] as Record<string, unknown>;
    expect(Object.keys(kb).sort()).toEqual(["bullets", "field", "parts", "part", "seen", "sender", "snap", "type", "v"].sort());
    expect(kb).toMatchObject({ v: 1, part: 1, parts: 1, sender: voice.prompts.sync.sender });
    expect(kb.sender).toMatch(/^[0-9a-f]{16}$/);
    expect((kb.bullets as unknown[][]).map((bullet) => bullet[1])).toEqual(kbDefaults);
    expect(peer.inbox).toHaveLength(2);
    expect(typesSent(relay)).toEqual(["bullet_state"]);
  });

  test("a local change sends that field at once; an edit taken from a peer whose labels Voice holds isn't answered", async () => {
    const { relay, voice } = await connected();
    voice.add("kb", "", "Voice fact");
    const sent = relay.messages("voice", "bullet_state");
    expect(sent.map((message) => message.field)).toEqual(["kb"]);
    const tuples = (sent[0] as { bullets: [string, string, string, number][] }).bullets;
    expect(tuples.at(-1)?.slice(0, 2)).toEqual(["", "Voice fact"]);

    relay.sent.length = 0;
    relay.inject("voice", bulletState("kb", tuples, (sent[0] as { seen: Record<string, number> }).seen));
    await relay.settle();
    expect(relay.sent).toEqual([]);
  });

  test("a snapshot with labels Voice lacks is merged and answered once; the merge is recorded as received, not as an edit", async () => {
    const { relay, voice } = await connected();
    relay.inject("voice", bulletState("kb", [["", "Peer fact", peerName, 1]], { [peerName]: 1 }));
    await relay.settle();

    expect(voice.texts("kb")).toEqual([...kbDefaults, "Peer fact"]);
    expect(relay.messages("voice", "bullet_state").map((message) => message.field)).toEqual(["kb"]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(voice.prompts.history.map((entry) => entry.source)).toEqual(["sync_receive"]);
  });

  test("the action rules, which Voice doesn't keep, are ignored: nothing changes and nothing is answered", async () => {
    const { relay, voice } = await connected();
    const before = { kb: voice.prompts.knowledgeBase, composition: voice.prompts.composition };
    relay.inject("voice", bulletState("action", [["delete", "Example rule", peerName, 1]], { [peerName]: 1 }));
    relay.inject("voice", JSON.stringify({ type: "prompt_state", data: { action: "- Example rule", action_updated_at: "2099-01-01T00:00:00.000Z" } }));
    await relay.settle();

    expect({ kb: voice.prompts.knowledgeBase, composition: voice.prompts.composition }).toEqual(before);
    expect(relay.sent).toEqual([]);
  });

  /** Only a `bullet_state` reaches the bullet fields (DS-VALIDATE): a released peer's request for the
   * texts, or a snapshot-shaped message of another type, changes nothing and logs no error. */
  test("a request for the texts gets no answer, and a message that isn't JSON, isn't an object or isn't a bullet_state is ignored", async () => {
    const { relay, voice } = await connected();
    const errors: string[] = [];
    configureLog({ isDebugBuild: true, sinks: { file: () => {}, error: (text) => errors.push(text) } });
    relay.inject("voice", JSON.stringify({ type: "request_state", fields: ["kb"] }));
    relay.inject("voice", JSON.stringify({ type: "request_state" }));
    relay.inject("voice", "{not json");
    relay.inject("voice", JSON.stringify(["bullet_state"]));
    relay.inject("voice", JSON.stringify({ type: "bullet_snapshot", v: 1, field: "kb", sender: "ffffffffffffffff", snap: "1", part: 1, parts: 1, bullets: [["", "Fact of another type", "ffffffff00000001", 1]], seen: { ffffffff00000001: 1 } }));
    await relay.settle();
    expect(relay.sent).toEqual([]);
    expect(voice.texts("kb")).toEqual(kbDefaults);
    expect(errors).toEqual([]);
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
  });

  test("an AI cache probe is answered at once, with nothing, under its id", async () => {
    const { relay } = await connected();
    relay.inject("voice", JSON.stringify({ type: "ai_cache_probe", keys: ["message-1"], probeId: "probe-1" }));
    relay.inject("voice", JSON.stringify({ type: "ai_cache_probe", keys: ["message-2"] }));
    await relay.settle();
    expect(relay.messages("voice", "ai_cache_response")).toEqual([{ type: "ai_cache_response", results: {}, probeId: "probe-1" }]);
  });
});

describe("a released device's texts (DS-LEGACY-IN)", () => {
  test("are imported, additions only, and what changed goes on as labelled bullets", async () => {
    const { relay, voice } = await connected();
    voice.remove("kb", "", kbDefaults[0] as string);
    relay.sent.length = 0;
    relay.inject("voice", JSON.stringify({ type: "prompt_state", data: { kb: `- ${kbDefaults[0] as string}\n- Legacy fact`, kb_updated_at: "2099-01-01T00:00:00.000Z" } }));
    await relay.settle();

    expect(voice.texts("kb")).toEqual([...kbDefaults.slice(1), "Legacy fact"]);
    expect(relay.messages("voice", "bullet_state").map((message) => message.field)).toEqual(["kb"]);
    expect(typesSent(relay)).toEqual(["bullet_state"]);
  });

  test("a text at epoch zero is skipped, and so is one with no time at all", async () => {
    const { relay, voice } = await connected();
    relay.inject("voice", JSON.stringify({ type: "prompt_state", data: { kb: "- Zero fact", kb_updated_at: epochZero } }));
    relay.inject("voice", JSON.stringify({ type: "prompt_state", data: { kb: "- Timeless fact" } }));
    relay.inject("voice", JSON.stringify({ type: "prompt_state", data: "- Not an object" }));
    await relay.settle();
    expect(voice.texts("kb")).toEqual(kbDefaults);
    expect(relay.sent).toEqual([]);
  });
});

describe("when sync runs", () => {
  test("while not allowed, nothing is sent and nothing is taken; the edits made meanwhile go once it is", async () => {
    const relay = new FakeRelay();
    relay.peer("thunderbird");
    const voice = new VoiceDevice(relay);
    voice.allowed = false;
    voice.sync.update();
    voice.add("kb", "", "Voice fact new");
    await relay.settle();
    expect(relay.urls).toEqual([]);
    expect(relay.sent).toEqual([]);

    voice.allowed = true;
    voice.sync.update();
    await relay.settle();
    const kb = relay.messages("voice", "bullet_state").find((message) => message.field === "kb") as { bullets: unknown[][] };
    expect(kb.bullets.map((bullet) => bullet[1])).toEqual([...kbDefaults, "Voice fact new"]);
  });

  test("while the texts' file can't be read, sync doesn't connect", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay, new UnreadableStore());
    voice.sync.update();
    await relay.settle();
    expect(relay.urls).toEqual([]);
  });

  test("turned off, it disconnects", async () => {
    const { relay, voice } = await connected();
    voice.allowed = false;
    voice.sync.update();
    expect(relay.isConnected("voice")).toBe(false);
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

/** Root ADR-035 (owner, 2026-10-29: "the sign-in is which do I sync with & who do I bill"): the texts
 * are the computer user's, kept whatever account is signed in, and shown and changed while signed out;
 * the account picks only the Device Sync group they sync with. */
describe("an account change", () => {
  const fact = "This computer's fact";

  async function signIn(voice: VoiceDevice, userID: string): Promise<void> {
    voice.auth.enqueue(200, Fixtures.sessionJSON({ access: `access-${userID}`, refresh: `refresh-${userID}`, userID }));
    await voice.account.verify(Fixtures.email, "123456");
    await vi.waitFor(() => expect(voice.account.session?.userID).toBe(userID));
  }

  test("signing out stops sync only, and another account's sign-in syncs the texts as they are", async () => {
    const relay = new FakeRelay();
    relay.peer("thunderbird");
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    voice.add("kb", "", fact);
    await relay.settle();

    voice.account.signOut();
    expect(relay.isConnected("voice")).toBe(false);
    expect(voice.texts("kb")).toContain(fact);
    voice.add("kb", "", "Typed while signed out");
    expect(voice.texts("kb")).toEqual([...kbDefaults, fact, "Typed while signed out"]);
    relay.sent.length = 0;

    await signIn(voice, "user-2");
    await relay.settle();
    expect(relay.isConnected("voice")).toBe(true);
    // Connected afresh, for the account now signed in: the group it syncs with.
    expect(relay.urls.at(-1)).toBe(`${config.deviceSyncURL}?token=access-user-2`);
    expect(voice.texts("kb")).toEqual([...kbDefaults, fact, "Typed while signed out"]);
    const sent = relay.sent.map((entry) => entry.text).join("\n");
    expect(sent).toContain(fact);
    expect(sent).toContain("Typed while signed out");
  });

  /** Signing straight into another account, with no sign-out between, leaves the first account's group:
   * its connection is closed and one opened for the account now signed in. */
  test("signing straight into another account connects afresh for it", async () => {
    const relay = new FakeRelay();
    const voice = new VoiceDevice(relay);
    voice.sync.update();
    await relay.settle();
    voice.add("kb", "", fact);
    await signIn(voice, "user-2");
    await relay.settle();
    expect(relay.urls).toEqual([`${config.deviceSyncURL}?token=access-1`, `${config.deviceSyncURL}?token=access-user-2`]);
    expect(relay.isConnected("voice")).toBe(true);
    expect(voice.texts("kb")).toContain(fact);
  });

  /** One device switching between two accounts' groups, each with a peer of its own: every exchange
   * is a union (neither group's writers are in the other's seen map), nothing is lost on the device or
   * on either group's peer, a text both groups added shows once (DS-DEDUP), and the line counts stay
   * the same however often the device switches. */
  describe("with two groups", () => {
    const name = (prefix: string) => (k: number) => `${prefix}${k.toString(16).padStart(8, "0")}`;
    const texts = (device: BulletDevice): string[] => device.state("kb").bullets.map((bullet) => bullet.text);
    const drain = (...relays: BulletRelay[]) => {
      for (const relay of relays) while (relay.deliverOldest());
    };

    async function twoGroups(): Promise<{ groupA: BulletRelay; groupB: BulletRelay; voice: BulletDevice; peerA: BulletDevice; peerB: BulletDevice }> {
      const groupA = new BulletRelay();
      const groupB = new BulletRelay();
      const voice = new BulletDevice("voice", new DeviceStore(), groupA, { name: name("0000000a") });
      const peerA = new BulletDevice("peerA", new DeviceStore(), groupA, { name: name("0000000b") });
      const peerB = new BulletDevice("peerB", new DeviceStore(), groupB, { name: name("0000000c") });
      for (const device of [voice, peerA, peerB]) await device.connect();
      voice.add("kb", "", fact);
      peerA.add("kb", "", "First account's fact");
      peerA.add("kb", "", "Fact both groups have");
      peerB.add("kb", "", "Second account's fact");
      peerB.add("kb", "", "Fact both groups have");
      drain(groupA, groupB);
      return { groupA, groupB, voice, peerA, peerB };
    }

    test("switching back and forth five times loses nothing and keeps the line counts", async () => {
      const { groupA, groupB, voice, peerA, peerB } = await twoGroups();
      const union = [...kbDefaults, fact, "First account's fact", "Fact both groups have", "Second account's fact"].sort();
      const counts: number[][] = [];
      for (let round = 0; round < 5; round += 1) {
        await voice.switchGroup(groupB);
        drain(groupB);
        await voice.switchGroup(groupA);
        drain(groupA);
        counts.push([voice, peerA, peerB].map((device) => texts(device).length));
      }
      expect(texts(voice).sort()).toEqual(union);
      expect(texts(peerA).sort()).toEqual(union);
      expect(texts(peerB).sort()).toEqual(union);
      expect(new Set(counts.map((count) => JSON.stringify(count))).size).toBe(1);
    });

    test("the texts are kept across a restart in the other group", async () => {
      const { groupB, voice, peerB } = await twoGroups();
      await voice.switchGroup(groupB);
      voice.restart();
      await voice.connect();
      drain(groupB);
      expect(texts(voice)).toEqual(expect.arrayContaining([fact, "First account's fact", "Second account's fact"]));
      expect(texts(peerB)).toEqual(expect.arrayContaining([fact, "First account's fact", "Second account's fact"]));
    });

    /** The seen map is kept across the switches, so a bullet deleted here stays deleted when a device of
     * the first group that missed the deletion comes back with it, though its writer has no other bullet
     * left: never brought back. */
    test("a deletion made before switching stays deleted against a device that missed it", async () => {
      const { groupA, groupB, voice, peerA, peerB } = await twoGroups();
      const offline = new BulletDevice("offlineA", new DeviceStore(), groupA, { name: name("0000000d") });
      await offline.connect();
      offline.add("kb", "", "Lone fact");
      drain(groupA);
      offline.disconnect();
      voice.delete("kb", "", "Lone fact");
      drain(groupA);
      for (let round = 0; round < 2; round += 1) {
        await voice.switchGroup(groupB);
        drain(groupB);
        await voice.switchGroup(groupA);
        drain(groupA);
      }
      // Only this device is there to answer it.
      peerA.disconnect();
      await offline.connect();
      drain(groupA);
      await voice.switchGroup(groupB);
      drain(groupB);
      for (const device of [voice, peerA, peerB, offline]) expect(texts(device), device.id).not.toContain("Lone fact");
    });

    /** A deletion still crosses between devices that were in contact: one the device made in the
     * second group reaches the first group's peer, which had the bullet from it. */
    test("a deletion of a bullet both groups have seen reaches both", async () => {
      const { groupA, groupB, voice, peerA, peerB } = await twoGroups();
      await voice.switchGroup(groupB);
      drain(groupB);
      expect(texts(peerB)).toContain("First account's fact");
      voice.delete("kb", "", "First account's fact");
      drain(groupB);
      expect(texts(peerB)).not.toContain("First account's fact");
      await voice.switchGroup(groupA);
      drain(groupA);
      expect(texts(peerA)).not.toContain("First account's fact");
      expect(texts(voice)).not.toContain("First account's fact");
    });
  });
});

describe("the relay's size (DS-CHUNK, DS-OVERSIZE)", () => {
  /** DS-SEEN-OUT, I3: `seen` names the bullets sent and those of the last snapshot merged only, so
   * what is sent does not grow with the snapshots merged before it. Each round a peer adds a bullet
   * under a writer of its own, then deletes it. */
  test("what is sent does not grow with the snapshots merged before", () => {
    const prompts = new UserPrompts(new MemoryStore());
    const sent = () => {
      const outgoing = prompts.sync.outgoing("kb");
      if (outgoing.kind !== "messages") throw new Error(outgoing.kind);
      return outgoing.messages.map((message) => ({ ...message, snap: "" }));
    };
    const empty = sent();
    // The knowledge base's defaults: its own bullets.
    const ownNames = empty.flatMap((message) => Object.keys(message.seen));
    expect(ownNames.length).toBeGreaterThan(0);
    for (let round = 1; round <= 30; round += 1) {
      const writer = `${round.toString(16).padStart(8, "0")}00000001`;
      expect(prompts.sync.receive(JSON.parse(bulletState("kb", [["", `Fact ${round}`, writer, 1]], { [writer]: 1 })))).toMatchObject({ kind: "merged", changed: true });
      expect(new Set(sent().flatMap((message) => Object.keys(message.seen)))).toEqual(new Set([...ownNames, writer]));
      expect(prompts.sync.receive(JSON.parse(bulletState("kb", [], { [writer]: 1 })))).toMatchObject({ kind: "merged", changed: true });
      expect(sent()).toEqual(empty);
    }
  });

  test("a field over it goes in parts that the other device takes whole", async () => {
    const relay = new FakeRelay();
    const sender = new VoiceDevice(relay, new MemoryStore(), "voice", undefined, { budget: () => 600 });
    const receiver = new VoiceDevice(relay, new MemoryStore(), "voice-2");
    sender.sync.update();
    receiver.sync.update();
    await relay.settle();
    for (let index = 1; index <= 12; index += 1) sender.add("kb", "", `Fact number ${index} of a dozen`);
    await relay.settle();

    expect(relay.messages("voice", "bullet_state").some((message) => (message.parts as number) > 1)).toBe(true);
    for (const message of relay.sent.filter((entry) => entry.from === "voice")) expect(new TextEncoder().encode(message.text).length).toBeLessThanOrEqual(600);
    expect(receiver.texts("kb")).toEqual(sender.texts("kb"));
  });

  test("a field in ten parts or more keeps every part within it, whatever the budget", () => {
    let most = 0;
    for (let budget = 360; budget <= 440; budget += 1) {
      const prompts = new UserPrompts(new MemoryStore(), { budget: () => budget });
      for (let index = 1; index <= 30; index += 1) prompts.addKnowledge(`Fact number ${index} of thirty`);
      const outgoing = prompts.sync.outgoing("kb");
      if (outgoing.kind !== "messages") throw new Error(`budget ${budget}: ${outgoing.kind}`);
      most = Math.max(most, outgoing.messages.length);
      for (const message of outgoing.messages) expect(new TextEncoder().encode(JSON.stringify(message)).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(outgoing.messages.flatMap((message) => message.bullets).map((bullet) => bullet[1])).toEqual(prompts.sync.state("kb").bullets.map((bullet) => bullet.text));
    }
    expect(most).toBeGreaterThanOrEqual(10);
  });

  /** The budget counts UTF-8 bytes, which the relay limits: text whose characters take two or four
   * bytes, here accented letters and owls (two UTF-16 units each), splits as its bytes require. */
  test("a field of multibyte text keeps every part within it in UTF-8 bytes, whatever the budget", () => {
    for (let budget = 360; budget <= 440; budget += 1) {
      const prompts = new UserPrompts(new MemoryStore(), { budget: () => budget });
      for (let index = 1; index <= 30; index += 1) prompts.addKnowledge(`Fait numéro ${index} \u{1F989}\u{1F989}\u{1F989}`);
      const outgoing = prompts.sync.outgoing("kb");
      if (outgoing.kind !== "messages") throw new Error(`budget ${budget}: ${outgoing.kind}`);
      for (const message of outgoing.messages) expect(new TextEncoder().encode(JSON.stringify(message)).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(outgoing.messages.flatMap((message) => message.bullets).map((bullet) => bullet[1])).toEqual(prompts.sync.state("kb").bullets.map((bullet) => bullet.text));
    }
  });

  /** The whole field as one message is measured in UTF-8 bytes too: a field of owls that fits the
   * budget by its length, but not by its bytes, goes in parts within it. */
  test("a field that fits by its length but not its UTF-8 bytes goes in parts within it", () => {
    let budget = config.deviceSyncMessageMaxBytes;
    const prompts = new UserPrompts(new MemoryStore(), { budget: () => budget });
    prompts.addKnowledge("\u{1F989}".repeat(40));
    prompts.addKnowledge("\u{1F989}".repeat(41));
    const whole = prompts.sync.outgoing("kb");
    if (whole.kind !== "messages" || whole.messages.length !== 1) throw new Error(`one message expected: ${whole.kind}`);
    const text = JSON.stringify(whole.messages[0]);
    budget = text.length;
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(budget);

    const outgoing = prompts.sync.outgoing("kb");
    if (outgoing.kind !== "messages") throw new Error(`budget ${budget}: ${outgoing.kind}`);
    expect(outgoing.messages.length).toBeGreaterThan(1);
    for (const message of outgoing.messages) expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(budget);
    expect(outgoing.messages.flatMap((message) => message.bullets).map((bullet) => bullet[1])).toEqual(prompts.sync.state("kb").bullets.map((bullet) => bullet.text));
  });

  /** A bullet fits by its UTF-8 bytes, not its length: 80 ASCII characters go, while 80 owls (160
   * UTF-16 units, 320 bytes) make one bullet over the budget, held back and kept. */
  test("one bullet of multibyte text over it in UTF-8 bytes is held back and kept, though its length fits", () => {
    const budget = 420;
    const ascii = new UserPrompts(new MemoryStore(), { budget: () => budget });
    ascii.addKnowledge("a".repeat(80));
    const sent = ascii.sync.outgoing("kb");
    if (sent.kind !== "messages") throw new Error(`ascii: ${sent.kind}`);
    for (const message of sent.messages) expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(budget);
    expect(sent.messages.flatMap((message) => message.bullets).map((bullet) => bullet[1])).toContain("a".repeat(80));

    const store = new MemoryStore();
    const owls = new UserPrompts(store, { budget: () => budget });
    owls.addKnowledge("\u{1F989}".repeat(80));
    expect(owls.sync.outgoing("kb")).toMatchObject({ kind: "oversize", budget });
    expect(new UserPrompts(new MemoryStore(store.snapshot())).sync.state("kb").bullets.map((bullet) => bullet.text)).toContain("\u{1F989}".repeat(80));
  });

  test("one bullet over it holds the field back: logged with sizes only, shown, and cleared once it fits", async () => {
    const { relay, voice } = await connected();
    const errors: string[] = [];
    const lines: [LogLevel, string][] = [];
    configureLog({ isDebugBuild: true, sinks: { file: (level, text) => lines.push([level, text]), error: (text) => errors.push(text) } });
    let changes = 0;
    voice.sync.observe(() => (changes += 1));

    const large = "Large fact ".repeat(config.deviceSyncMessageMaxBytes / 10).trim();
    voice.add("kb", "", large);
    await relay.settle();

    expect(relay.sent).toEqual([]);
    expect(voice.sync.tooLarge).toBe(true);
    expect(changes).toBe(1);
    expect(errors).toEqual([expect.stringMatching(/^DeviceSync: kb not sent: one bullet makes a \d+-byte message, over the relay's 126976$/)]);
    expect(lines.filter(([level, text]) => level !== "CONTENT" && text.includes("Large fact"))).toEqual([]);

    voice.remove("kb", "", large);
    await relay.settle();
    expect(voice.sync.tooLarge).toBe(false);
    expect(changes).toBe(2);
    expect(relay.messages("voice", "bullet_state").map((message) => message.field)).toEqual(["kb"]);
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
  });

  /** R19 discards by (sender, field) only when the refused part's sender is a string: an array of that
   * sender's id reads as the same key, and is not that sender. */
  test("a refused part whose sender is not a string drops no snapshot", () => {
    const prompts = new UserPrompts(new MemoryStore());
    const part = (fields: Record<string, unknown>) => ({ ...JSON.parse(bulletState("kb", [["", "Half fact", peerName, 1]], { [peerName]: 2 })), parts: 2, ...fields });
    expect(prompts.sync.receive(part({}))).toEqual({ kind: "partial" });
    expect(prompts.sync.receive(part({ sender: ["ffffffffffffffff"], snap: "0000000000000002", v: 2 }))).toMatchObject({ kind: "invalid" });
    expect(prompts.sync.receive(part({ part: 2, bullets: [["", "Other half", peerName, 2]] }))).toMatchObject({ kind: "merged", changed: true });
    expect(prompts.shown("kb", "").map((bullet) => bullet.text)).toEqual(expect.arrayContaining(["Half fact", "Other half"]));
  });

  test("an incomplete snapshot is dropped with the connection", async () => {
    const { relay, voice } = await connected();
    const part = JSON.parse(bulletState("kb", [["", "Half fact", peerName, 1]], { [peerName]: 1 })) as Record<string, unknown>;
    relay.inject("voice", JSON.stringify({ ...part, parts: 2 }));
    await relay.settle();
    voice.sync.wake();
    await relay.settle();
    relay.inject("voice", JSON.stringify({ ...part, part: 2, parts: 2, bullets: [["", "Other half", peerName, 2]] }));
    await relay.settle();
    expect(voice.texts("kb")).toEqual(kbDefaults);
  });
});

describe("an in-process reload of the texts (DS-NAME-ABANDON, R7)", () => {
  /** Two devices that both hold "Alpha", added on A. */
  async function alphaOnBoth(): Promise<{ relay: BulletRelay; a: BulletDevice; b: BulletDevice }> {
    const relay = new BulletRelay();
    const a = new BulletDevice("A", new DeviceStore(), relay, { name: (k) => `0000000a${k.toString(16).padStart(8, "0")}` });
    const b = new BulletDevice("B", new DeviceStore(), relay, { name: (k) => `0000000b${k.toString(16).padStart(8, "0")}` });
    await a.connect();
    await b.connect();
    a.add("kb", "", "Alpha");
    while (relay.deliverOldest());
    expect(b.state("kb").bullets.map((bullet) => bullet.text)).toContain("Alpha");
    return { relay, a, b };
  }

  function texts(device: BulletDevice): string[] {
    return device.state("kb").bullets.map((bullet) => bullet.text);
  }

  test("after the user's factory reset, the next bullet is under a fresh name, and no peer loses a bullet", async () => {
    const { relay, a, b } = await alphaOnBoth();
    const before = a.state("kb").bullets.find((bullet) => bullet.text === "Alpha");
    a.prompts.resetFile(() => a.store.replaceWith(new DeviceStore()));
    a.add("kb", "", "Beta");
    while (relay.deliverOldest());

    const beta = a.state("kb").bullets.find((bullet) => bullet.text === "Beta");
    expect(beta?.name).not.toBe(before?.name);
    expect(texts(b)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    expect(texts(a)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
  });
});

describe("an upgrade from the texts of a released version (DS-UPGRADE)", () => {
  /** A store whose writes all fail while `failing` is set, as a full disk's. */
  class FullDiskStore extends DeviceStore {
    failing = false;

    override setAll(values: Readonly<Record<string, unknown>>): boolean {
      return !this.failing && super.setAll(values);
    }
  }

  function legacyStore(): FullDiskStore {
    const store = new FullDiskStore(new DeviceStore().snapshot());
    store.set("user_prompts:user_kb.md", "- Alpha\n- Beta");
    return store;
  }

  function device(id: string, store: DeviceStore, relay: BulletRelay): BulletDevice {
    return new BulletDevice(id, store, relay, { name: (k) => `0000000${id.toLowerCase()}${k.toString(16).padStart(8, "0")}` });
  }

  const kbTexts = (device: BulletDevice) => device.state("kb").bullets.map((bullet) => bullet.text);

  test("is sent nothing of until it is saved, then everything it holds", async () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    store.failing = true;
    const a = device("A", store, relay);
    const b = device("B", new DeviceStore(), relay);
    await b.connect();
    await a.connect();

    expect(kbTexts(a)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    for (const field of ["kb", "composition", "action"]) expect(relay.sent("A", field)).toBe(0);

    store.failing = false;
    a.disconnect();
    await a.connect();
    while (relay.deliverOldest());
    expect(kbTexts(b)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
  });

  /** R20: the upgrade's write failed on connect, and a later read saves it: sent then, not at the next
   * connect. */
  test("saved by a read after a failed write on connect, is sent at once, every field it saved", async () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    store.set("user_prompts:user_composition.md", "# Language (DO NOT EDIT/DELETE THIS SECTION HEADER)\n- Write in French.");
    store.failing = true;
    const a = device("A", store, relay);
    const b = device("B", new DeviceStore(), relay);
    await b.connect();
    await a.connect();
    while (relay.deliverOldest());
    expect(relay.sent("A", "kb")).toBe(0);

    store.failing = false;
    expect(kbTexts(a)).toEqual(["Alpha", "Beta"]);
    expect(store.get("user_prompts:user_kb.md")).toBeUndefined();
    expect(store.get("user_prompts:user_composition.md")).toBeUndefined();
    while (relay.deliverOldest());
    expect(kbTexts(b)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    expect(b.state("composition").bullets.map((bullet) => bullet.text)).toContain("Write in French.");
  });

  /** R20: an upgrade saved by a commit of another field sends the upgraded field too. */
  test("saved by an edit of another field, is sent with it", async () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    store.failing = true;
    const a = device("A", store, relay);
    const b = device("B", new DeviceStore(), relay);
    await b.connect();
    await a.connect();
    while (relay.deliverOldest());

    store.failing = false;
    a.add("composition", "general", "Sign off briefly.");
    while (relay.deliverOldest());
    expect(b.state("composition").bullets.map((bullet) => bullet.text)).toContain("Sign off briefly.");
    expect(kbTexts(b)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
  });

  /** The upgrade's write fails, so a local add in the same commit is refused: saving it would make the
   * field upgraded with the defaults alone, and the texts from before would never be read again (I1). */
  test("takes no local edit in before it is saved, so no text it held is lost", () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    const a = device("A", store, relay);
    store.failNext = true;
    expect(a.prompts.addKnowledge("Gamma")).toEqual({ outcome: "unsaved", fields: [] });
    expect(store.failNext).toBe(false);

    const reader = new UserPrompts(new MemoryStore(store.snapshot()));
    expect(reader.shown("kb", "").map((bullet) => bullet.text)).toEqual(["Alpha", "Beta"]);
    expect(kbTexts(a)).toEqual(["Alpha", "Beta"]);
  });

  /** The upgrade's write fails and the next would succeed: the snapshot is refused rather than merged
   * into the empty state a field not upgraded yet reads as, which would save over the texts. */
  test("takes no snapshot in before it is saved, so no text it held is lost", () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    const a = device("A", store, relay);
    store.failNext = true;
    expect(a.prompts.sync.receive(JSON.parse(bulletState("kb", [["", "Gamma", peerName, 1]], { [peerName]: 1 })))).toEqual({ kind: "unsaved", field: "kb" });
    expect(store.failNext).toBe(false);

    // A later reader of the store finds the texts as they were, upgraded then.
    const reader = new UserPrompts(new MemoryStore(store.snapshot()));
    expect(reader.shown("kb", "").map((bullet) => bullet.text)).toEqual(["Alpha", "Beta"]);
    expect(kbTexts(a)).toEqual(["Alpha", "Beta"]);
  });
});

describe("the connection", () => {
  test("keeps alive with the relay's exact ping, and sends nothing else on a timer", async () => {
    const { relay } = await connected();
    const sent: string[] = [];
    const send = relay.send.bind(relay);
    relay.send = (from, text) => {
      if (from.name === "voice") sent.push(text);
      send(from, text);
    };
    await vi.advanceTimersByTimeAsync(10 * config.deviceSyncPingInterval);
    expect(sent).toEqual(Array.from({ length: 10 }, () => '{"type":"ping"}'));
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

  test("a wake while connected connects afresh and sends each field again", async () => {
    const { relay, voice } = await connected();
    voice.sync.wake();
    await relay.settle();

    expect(relay.urls).toHaveLength(2);
    expect(relay.messages("voice", "bullet_state").map((message) => message.field)).toEqual(["kb", "composition"]);
  });
});
