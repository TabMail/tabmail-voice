// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import type { AccountModel } from "../src/core/account.js";
import { CompletionsClient } from "../src/core/backend.js";
import { screenVariables } from "../src/core/agent/tools.js";
import { DictationCleanup, textAroundCaret } from "../src/core/cleanup.js";
import * as config from "../src/core/config.js";
import { CancellationError, sleep, TimeoutError, withTimeout } from "../src/core/timeout.js";
import { screen } from "./screens.js";
import { eventually, Fixtures, signedIn, StubTransport } from "./support.js";

describe("DictationCleanup.message", () => {
  test("sends the dictation with where it goes and what is on screen", () => {
    const context = screen({
      appName: "Example Notes",
      host: "notes.example.com",
      terminalProgram: "example-shell",
      windowTitle: "Weekly sync",
      renderedText: "## Agenda\n» Ask Jordan about the ‸",
    });

    const message = DictationCleanup.message("quarterly road map", context);

    expect(message.role).toBe("system");
    // The backend's prompt name, spelled out: comparing with the config would pass a typo.
    expect(message.content).toBe("system_prompt_dictate_cleanup");
    expect(message.vars).toEqual({
      dictation: "quarterly road map",
      app_name: "Example Notes",
      web_host: "notes.example.com",
      terminal_program: "example-shell",
      window_title: "Weekly sync",
      screen_text: "## Agenda\n» Ask Jordan about the ‸",
    });
  });

  /** Without Accessibility access there is no context: the prompt still gets every field, empty. */
  test("without context every field is empty", () => {
    expect(DictationCleanup.message("hello", null).vars).toEqual({
      dictation: "hello", app_name: "", web_host: "", terminal_program: "", window_title: "", screen_text: "",
    });
  });
});

/** The cleanup gets only the text around the caret (owner, 2026-09-28: the whole screen made it
 * slow); agent mode still gets the whole screen. */
describe("the cleanup's screen text", () => {
  const before = "b".repeat(config.cleanupContextBefore);
  const after = "a".repeat(config.cleanupContextAfter);
  const page = `## Inbox\n${"An earlier message on screen.\n".repeat(200)}`;
  const rendered = `${page}» Dear Alex,\n» ${before}‸${after}\n» ${"More of the draft. ".repeat(100)}\n[Send]`;

  test("is the text within its reach of the caret, markers kept", () => {
    const text = textAroundCaret(rendered);
    expect(text).toBe(`${before}‸${after}`);
    expect(DictationCleanup.message("hello", screen({ renderedText: rendered })).vars.screen_text).toBe(text);
  });

  /** Near the start or end of the screen it takes what there is: the text before the field too. */
  test("reaches past the field's start and stops at the screen's ends", () => {
    expect(textAroundCaret("## Agenda\n» Ask Jordan about the ‸")).toBe("## Agenda\n» Ask Jordan about the ‸");
    const short = `Lunch with Sam?\n» Sure, ‸ works\n[Send]`;
    expect(textAroundCaret(short)).toBe(short);
  });

  /** A selection counts as text after the caret, its markers kept while in reach. */
  test("keeps a selection within reach", () => {
    expect(textAroundCaret("» Note: ‸Ship it Friday.‸ Thanks")).toBe("» Note: ‸Ship it Friday.‸ Thanks");
  });

  /** A cut never splits a character: an emoji or accented letter at the edge is kept whole or left
   * out whole. */
  test("cuts between characters", () => {
    const family = "👩‍👩‍👧";
    const edgeBefore = `${family}${"b".repeat(config.cleanupContextBefore - 1)}`;
    const edgeAfter = `${"a".repeat(config.cleanupContextAfter - 1)}${family}`;
    const text = textAroundCaret(`» x${edgeBefore}‸${edgeAfter}y`);
    expect(text.startsWith("b") || text.startsWith(family)).toBe(true);
    expect(text.endsWith("a") || text.endsWith(family)).toBe(true);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((segment) => segment.segment)).not.toContain("\u200d");
    expect(text).toContain("‸");
  });

  /** Only the focused field's lines hold the caret; the marker on a page line is the page's own
   * text. No field with the caret sends nothing. */
  test("finds the caret on the focused field only", () => {
    expect(textAroundCaret("A page about the ‸ character\n» Hello ‸")).toBe("A page about the ‸ character\n» Hello ‸");
    const tail = " ‸ in the page\n» Hello ";
    expect(textAroundCaret(`${"x".repeat(1_000)}${tail}‸`)).toBe(`${"x".repeat(config.cleanupContextBefore - tail.length)}${tail}‸`);
    expect(textAroundCaret("## Inbox\nA page with no field")).toBe("");
    expect(textAroundCaret("A page about the ‸ character")).toBe("");
    expect(textAroundCaret("")).toBe("");
  });

  test("leaves agent mode the whole screen", () => {
    expect(screenVariables("summarise this", screen({ renderedText: rendered })).screen_text).toBe(rendered);
  });
});

/** The timeout returns the operation's error or its own deadline error, even if the operation
 * cannot respond to cancellation. */
describe("withTimeout", () => {
  /** Cleanup's fallback hides error types; callers of the timeout must still get the original error. */
  test("passes through the operation's error", async () => {
    const failure = new Error("example");
    await expect(withTimeout(30_000, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  /** The deadline releases the caller without waiting for an operation that ignores its signal. */
  test("times out without waiting for an operation that ignores cancellation", async () => {
    let signalled: AbortSignal | undefined;
    const started = performance.now();
    const result = withTimeout(200, (signal) => {
      signalled = signal;
      return new Promise<string>(() => {});
    });

    const error = await result.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).duration).toBe(200);
    expect((error as TimeoutError).message).toBe("Operation timed out after 200ms");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(signalled?.aborted).toBe(true);
  });

  test("sleep ends early when its signal aborts", async () => {
    const controller = new AbortController();
    const sleeping = sleep(30_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toBeInstanceOf(CancellationError);
    await expect(sleep(10, controller.signal)).rejects.toBeInstanceOf(CancellationError);
  });
});

/** What gets pasted: the cleaned-up text, or the transcript as heard whenever the cleanup fails. */
describe("DictationCleanup.cleanUp", () => {
  const transcript = "ask jordan about the road map";

  function setup() {
    const backend = new StubTransport();
    const auth = new StubTransport();
    const cleanUp = (account: AccountModel = signedIn(auth), timeout = config.cleanupTimeout) =>
      DictationCleanup.cleanUp(transcript, null, new CompletionsClient("https://api.example.com", "v", backend.transport), account, Fixtures.userId, timeout);
    return { backend, auth, cleanUp };
  }

  test("pastes the cleaned-up text", async () => {
    const { backend, cleanUp } = setup();
    backend.enqueue(200, Fixtures.completionsStream(`{"assistant":" Ask Jordan about the roadmap.\\n"}`));

    expect(await cleanUp()).toBe("Ask Jordan about the roadmap.");
    expect(backend.requests).toHaveLength(1);
    expect(backend.message(0)?.dictation).toBe(transcript);
  });

  /** Only an empty reply is a malfunction; even one character can be the whole dictation. */
  test("a single-character reply is still used", async () => {
    const { backend, cleanUp } = setup();
    backend.enqueue(200, Fixtures.reply("é"));
    expect(await cleanUp()).toBe("é");
  });

  /** A cleanup still running at its timeout is abandoned: the transcript is pasted as heard,
   * without waiting for the reply, and the request is cancelled. */
  test("a cleanup past its timeout pastes the transcript as heard", async () => {
    const { backend, cleanUp } = setup();
    backend.enqueue(200, Fixtures.reply("Ask Jordan about the roadmap."));
    let cancelled = false;
    backend.gate = async (request) => {
      await sleep(5_000, request.signal).catch(() => {
        cancelled = true;
      });
    };
    const started = performance.now();

    expect(await cleanUp(undefined, 200)).toBe(transcript);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(backend.requests).toHaveLength(1);
    expect(await eventually(() => cancelled)).toBe(true);
  });

  test("a cleanup within its timeout pastes the cleaned-up text", async () => {
    const { backend, cleanUp } = setup();
    backend.enqueue(200, Fixtures.reply("Ask Jordan about the roadmap."));
    backend.gate = () => sleep(100);

    expect(await cleanUp(undefined, 2_000)).toBe("Ask Jordan about the roadmap.");
  });

  test.each([
    [500, `{"error":"internal_error"}`],
    [402, `{"error":"no_active_subscription"}`],
    [429, `{"error":"rate_limited"}`],
    [200, ': primer\n\nevent: keepalive\ndata: {}\n\nevent: error\ndata: {"error":"internal_error"}\n\n'],
    [200, Fixtures.completionsStream(`{"error":"Requested prompt is not available for this client platform."}`)],
    [200, Fixtures.completionsStream(`{"assistant":" \\n"}`)],
    [200, ": primer\n\nevent: keepalive\ndata: {}\n\n"],
  ])("a failed cleanup (HTTP %i) pastes the transcript as heard", async (status, body) => {
    const { backend, cleanUp } = setup();
    backend.enqueue(status, body);

    expect(await cleanUp()).toBe(transcript);
    expect(backend.requests).toHaveLength(1);
  });

  test("an unreachable backend pastes the transcript as heard", async () => {
    const { backend, cleanUp } = setup();
    // Nothing queued: the transport fails, as it does offline.
    expect(await cleanUp()).toBe(transcript);
    expect(backend.requests).toHaveLength(1);
  });

  test("signed out pastes the transcript without calling the backend", async () => {
    const { backend, cleanUp } = setup();
    expect(await cleanUp(signedIn(new StubTransport(), null))).toBe(transcript);
    expect(backend.requests).toHaveLength(0);
  });

  test("an expired token is refreshed once and the cleanup retried", async () => {
    const { backend, auth, cleanUp } = setup();
    backend.enqueue(401, { error: "invalid_token" });
    backend.enqueue(200, Fixtures.reply("Ask Jordan about the roadmap."));
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-2", refresh: "refresh-2" }));

    expect(await cleanUp()).toBe("Ask Jordan about the roadmap.");
    expect(backend.authorizations).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(auth.requests).toHaveLength(1);
  });

  test("a token rejected again after the refresh pastes the transcript as heard", async () => {
    const { backend, auth, cleanUp } = setup();
    backend.enqueue(401, { error: "invalid_token" });
    backend.enqueue(401, { error: "invalid_token" });
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-2", refresh: "refresh-2" }));

    expect(await cleanUp()).toBe(transcript);
    expect(backend.authorizations).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(auth.requests).toHaveLength(1);
  });

  test("a rejected refresh pastes the transcript as heard", async () => {
    const { backend, auth, cleanUp } = setup();
    backend.enqueue(401, { error: "invalid_token" });
    auth.enqueue(400, { error: "invalid_grant" });

    expect(await cleanUp()).toBe(transcript);
    expect(backend.requests).toHaveLength(1);
  });

  /** The user signed out and into another account after the dictation was transcribed. */
  test("a dictation is not cleaned up under another account", async () => {
    const { backend, cleanUp } = setup();
    expect(await cleanUp(signedIn(new StubTransport(), Fixtures.session({ access: "access-b", userId: "user-2" })))).toBe(transcript);
    expect(backend.requests).toHaveLength(0);
  });

  /** The switch happens while the first request is in flight: the retry must not go out under the
   * other account's token. */
  test("a switch during the request stops the retry", async () => {
    const { backend, auth, cleanUp } = setup();
    const account = signedIn(auth);
    backend.enqueue(401, { error: "invalid_token" });
    backend.enqueue(200, Fixtures.reply("Ask Jordan about the roadmap."));
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b", refresh: "refresh-b", userId: "user-2" }));
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b2", refresh: "refresh-b2", userId: "user-2" }));
    backend.gate = async () => {
      account.signOut();
      await account.verify(Fixtures.email, "123456").catch(() => undefined);
    };

    expect(await cleanUp(account)).toBe(transcript);
    expect(backend.authorizations).toEqual(["Bearer access-1"]);
    expect(account.session?.userId).toBe("user-2");
  });
});
