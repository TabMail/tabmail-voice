// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import type { ChatTurn } from "../../../src/core/agent/chat.js";
import { CompletionsClient } from "../../../src/core/backend/completions.js";
import * as config from "../../../src/core/config.js";
import { extractBullets } from "../../../src/core/personalization/bulletMerge.js";
import { defaultKnowledgeBase } from "../../../src/core/personalization/defaults.js";
import { KBRefiner, refineChatHistory, refineTime } from "../../../src/core/personalization/kbRefine.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";
import { deferred, Fixtures, signedIn, StubTransport } from "../../support/stubs.js";

const kbKey = "user_prompts:user_kb.md";

function turns(count: number): ChatTurn[] {
  return Array.from({ length: count }, (_, index) => ({ id: index, request: `Request ${index}`, tool: "answer" as const, reply: `Reply ${index}`, questions: [] }));
}

function refined(knowledgeBase: string): string {
  return Fixtures.completionsStream(JSON.stringify({ assistant: "", refined_kb: knowledgeBase }));
}

function setup(knowledgeBase = "- alpha.\n- beta.") {
  const completions = new StubTransport();
  const client = new CompletionsClient("https://api.example.com", "v", completions.transport);
  const prompts = new UserPrompts(new MemoryStore({ [kbKey]: knowledgeBase }));
  const account = signedIn();
  return { completions, client, prompts, account, refiner: new KBRefiner(prompts) };
}

describe("refineChatHistory", () => {
  /** Only what was said goes, each side named as Thunderbird and iOS name it. */
  test("a chat is its requests and replies, in order", () => {
    const chat: ChatTurn[] = [
      { id: 0, request: "When is lunch?", tool: "answer", reply: "At noon.", questions: [] },
      { id: 1, request: "Write it up", tool: "compose", reply: "", questions: [] },
    ];
    expect(refineChatHistory(chat)).toBe("[USER]: When is lunch?\n\n[AGENT]: At noon.\n\n[USER]: Write it up");
  });
});

describe("refineTime", () => {
  test("the time is the weekday, date and time, with the zone's name", () => {
    const date = new Date();
    date.setHours(9, 5, 7);
    const two = (value: number) => String(value).padStart(2, "0");
    const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
    expect(refineTime(date, "Example/Zone")).toBe(`${weekday} ${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} 09:05:07 (Example/Zone)`);
  });
});

/** A closed chat's lessons are merged into the knowledge base, as iOS's `KBRefinementService` does. */
describe("KBRefiner", () => {
  test("a chat of fewer requests than the minimum isn't refined", async () => {
    const { completions, client, account, refiner, prompts } = setup();
    await refiner.refine(turns(config.kbRefineMinUserTurns - 1), client, account, Fixtures.userID);
    expect(completions.requests).toHaveLength(0);
    expect(prompts.knowledgeBase).toBe("- alpha.\n- beta.");
  });

  /** The retention and the bullet limit go as numbers: the backend reads only a number. */
  test("the refine is sent the knowledge base, the chat and its limits, with no tools", async () => {
    const { completions, client, account, refiner } = setup();
    completions.enqueue(200, refined("- alpha.\n- beta."));
    const chat = turns(config.kbRefineMinUserTurns);

    await refiner.refine(chat, client, account, Fixtures.userID);

    expect(completions.requests).toHaveLength(1);
    expect(completions.body(0).disable_tools).toBe(true);
    const message = completions.message(0);
    expect(message?.content).toBe("system_prompt_kb_refine");
    const vars = message ?? {};
    expect(vars.current_user_kb_md).toBe("- alpha.\n- beta.");
    expect(vars.chat_history).toBe(refineChatHistory(chat));
    expect(vars.reminder_retention_days).toBe(config.kbRefineReminderRetentionDays);
    expect(vars.max_bullets).toBe(config.kbRefineMaxBullets);
    expect(typeof vars.reminder_retention_days).toBe("number");
    expect(typeof vars.max_bullets).toBe("number");
    expect(vars.current_time).toMatch(/^[A-Z][a-z]+day \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \(.+\)$/);
  });

  test("what the refine learned is kept", async () => {
    const { completions, client, account, refiner, prompts } = setup();
    completions.enqueue(200, refined("- alpha.\n- Prefers short replies."));
    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    expect(prompts.knowledgeBase).toBe("- alpha.\n- Prefers short replies.");
  });

  /** A statement the user kept (or removed) while the refine ran stays so: the refine's answer is
   * merged into the knowledge base as it is now, not written over it. */
  test("an edit made while the refine runs survives it", async () => {
    const { completions, client, account, refiner, prompts } = setup();
    const sent = deferred<void>();
    const release = deferred<void>();
    completions.gate = async () => {
      sent.resolve();
      await release.promise;
    };
    completions.enqueue(200, refined("- alpha.\n- beta.\n- Prefers short replies."));

    const refining = refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    await sent.promise;
    prompts.updateKnowledgeBase(() => "- beta.\n- [Pinned] Added meanwhile.");
    release.resolve();
    await refining;

    expect(extractBullets(prompts.knowledgeBase)).toEqual(["beta.", "[Pinned] Added meanwhile.", "Prefers short replies."]);
  });

  /** The backend keeps the refine's lines as the model wrote them: a copy of a bullet with spaces
   * at its end is still that bullet, so a removal made while the refine ran stands. */
  test("a removal made while the refine runs survives a padded copy of the bullet", async () => {
    const { completions, client, account, refiner, prompts } = setup("- alpha.\n- Works with Sam.");
    const sent = deferred<void>();
    const release = deferred<void>();
    completions.gate = async () => {
      sent.resolve();
      await release.promise;
    };
    completions.enqueue(200, refined("- alpha.\n- Works with Sam.  "));

    const refining = refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    await sent.promise;
    prompts.updateKnowledgeBase(() => "- alpha.");
    release.resolve();
    await refining;

    expect(prompts.knowledgeBase).toBe("- alpha.");
  });

  test("an indented bullet the refine learned is kept", async () => {
    const { completions, client, account, refiner, prompts } = setup("- alpha.");
    completions.enqueue(200, refined("- alpha.\n  - Prefers short replies."));
    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    expect(prompts.knowledgeBase).toBe("- alpha.\n- Prefers short replies.");
  });

  /** One at a time, as on iOS: a chat closed while one runs is passed over. */
  test("a chat closed while a refine runs isn't refined", async () => {
    const { completions, client, account, refiner } = setup();
    const release = deferred<void>();
    completions.gate = () => release.promise;
    completions.enqueue(200, refined("- alpha."));
    completions.enqueue(200, refined("- beta."));

    const first = refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    release.resolve();
    await first;

    expect(completions.requests).toHaveLength(1);
    // The next chat is refined once the first is done.
    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    expect(completions.requests).toHaveLength(2);
  });

  /** Reset and Restore put back a whole text the user chose: a refine of the text they replaced,
   * answered after, is dropped, never merged into their choice. */
  test.each(["reset", "restore"] as const)("a refine answered after the knowledge base was put back by %s is dropped", async (action) => {
    const { completions, client, account, refiner, prompts } = setup();
    // A history entry holding "- alpha.\n- beta.", then the default: what Restore puts back.
    prompts.resetKnowledgeBase();
    const entry = prompts.history.at(-1)?.id ?? "";
    if (action === "reset") expect(prompts.restore(entry)).toBe(true);
    const sent = deferred<void>();
    const release = deferred<void>();
    completions.gate = async () => {
      sent.resolve();
      await release.promise;
    };
    completions.enqueue(200, refined("- Learned from the chat."));
    completions.enqueue(200, refined("- Learned from the next chat."));

    const refining = refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    await sent.promise;
    expect(action === "reset" ? prompts.resetKnowledgeBase() : prompts.restore(entry)).toBe(true);
    const chosen = prompts.knowledgeBase;
    expect(chosen).toBe(action === "reset" ? defaultKnowledgeBase : "- alpha.\n- beta.");
    release.resolve();
    await refining;

    expect(prompts.knowledgeBase).toBe(chosen);
    // The next refine runs and is kept.
    completions.gate = undefined;
    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    expect(extractBullets(prompts.knowledgeBase)).toContain("Learned from the next chat.");
  });

  /** Only putting back the knowledge base drops a refine: a writing-style Reset meanwhile leaves the
   * knowledge base as it was, and the refine is merged into it. */
  test("a refine answered after the writing style was reset is kept", async () => {
    const { completions, client, account, refiner, prompts } = setup();
    const sent = deferred<void>();
    const release = deferred<void>();
    completions.gate = async () => {
      sent.resolve();
      await release.promise;
    };
    completions.enqueue(200, refined("- Learned from the chat."));

    const refining = refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    await sent.promise;
    expect(prompts.resetComposition()).toBe(true);
    release.resolve();
    await refining;

    // The refine's text, merged into the knowledge base it was made from.
    expect(extractBullets(prompts.knowledgeBase)).toEqual(["Learned from the chat."]);
  });

  /** A refine answered after the account changed never reaches the next account's knowledge base. */
  test("a refine answered after the account changed is dropped", async () => {
    const { completions, client, account, refiner, prompts } = setup();
    const sent = deferred<void>();
    const release = deferred<void>();
    completions.gate = async () => {
      sent.resolve();
      await release.promise;
    };
    completions.enqueue(200, refined("- Learned from the first account."));

    const refining = refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    await sent.promise;
    account.signOut();
    release.resolve();
    await refining;

    expect(prompts.knowledgeBase).toBe("- alpha.\n- beta.");
  });

  test("a chat closed under another account than the one signed in isn't sent", async () => {
    const { completions, client, account, refiner, prompts } = setup();
    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, "another-user");
    expect(completions.requests).toHaveLength(0);
    expect(prompts.knowledgeBase).toBe("- alpha.\n- beta.");
  });

  /** A failure is only logged; the knowledge base stays, and the next chat is refined. */
  test("a failed refine changes nothing and lets the next one run", async () => {
    const { completions, client, account, refiner, prompts } = setup();
    completions.enqueue(500, { error: "unavailable" });
    completions.enqueue(200, Fixtures.reply("No refined knowledge base here."));

    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);
    await refiner.refine(turns(config.kbRefineMinUserTurns), client, account, Fixtures.userID);

    expect(completions.requests).toHaveLength(2);
    expect(prompts.knowledgeBase).toBe("- alpha.\n- beta.");
  });
});
