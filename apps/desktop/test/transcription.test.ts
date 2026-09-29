// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { withFreshToken } from "../src/core/account.js";
import { BackendError, type CleanupVariables, TranscriptionClient } from "../src/core/backend.js";
import { base64 } from "../src/core/text.js";
import { Fixtures, signedIn, StubTransport } from "./support.js";

const baseURL = "https://api.example.com";
const wav = new TextEncoder().encode("RIFF-test-audio");
const cleanup: CleanupVariables = {
  app_name: "Example Notes",
  web_host: "",
  terminal_program: "",
  window_title: "Weekly sync",
  screen_text: "» We agreed that ‸",
  dictionary: "Xyvora",
};

function makeClient(stub: StubTransport, version = "0.1.0"): TranscriptionClient {
  return new TranscriptionClient(baseURL, version, stub.transport);
}

async function backendError(promise: Promise<unknown>): Promise<BackendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackendError) return error;
    throw error;
  }
  throw new Error("expected a BackendError");
}

describe("TranscriptionClient", () => {
  test("sends the recording to the transcribe endpoint", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, { text: "Hello there.", duration_seconds: 1.2 });

    const transcription = await makeClient(stub).transcribe(wav, null, [], "token-abc");

    // No cleanup asked for, none returned.
    expect(transcription).toEqual({ text: "Hello there.", cleanedText: null });
    const request = stub.requests[0];
    expect(request?.url).toBe("https://api.example.com/dictation/transcribe");
    expect(request?.method).toBe("POST");
    expect(request?.headers.Authorization).toBe("Bearer token-abc");
    expect(request?.headers["X-Client-Type"]).toBe("macos");
    expect(request?.headers["X-Client-Version"]).toBe("0.1.0");
    expect(stub.body(0)).toEqual({ format: "wav", audio: Buffer.from(wav).toString("base64") });
  });

  /** The language picks the backend's model; without one, the body has no `language` at all. */
  test("sends the language when there is one", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, { text: "안녕하세요." });
    stub.enqueue(200, { text: "Hello." });
    const client = makeClient(stub);

    await client.transcribe(wav, "ko", [], "t");
    await client.transcribe(wav, null, [], "t");

    expect(stub.body(0).language).toBe("ko");
    expect(Object.keys(stub.body(1)).sort()).toEqual(["audio", "format"]);
  });

  /** The dictionary's words go as `vocabulary`, which the backend hands the speech model
   * (ADR-DESK-038); without words, the body has no `vocabulary` at all. */
  test("sends the dictionary's words when there are some", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, { text: "Xyvora." });
    stub.enqueue(200, { text: "Hello." });
    const client = makeClient(stub);

    await client.transcribe(wav, "en", ["Xyvora", "Kaelthorne Draszek"], "t");
    await client.transcribe(wav, "en", [], "t");

    expect(stub.body(0).vocabulary).toEqual(["Xyvora", "Kaelthorne Draszek"]);
    expect(Object.keys(stub.body(1)).sort()).toEqual(["audio", "format", "language"]);
  });

  /** A dictation's cleanup variables go as `cleanup`, and the backend cleans up the transcript in
   * the same request (backend ADR-027); without them, the body has no `cleanup` at all. */
  test("sends the cleanup's variables and returns the cleaned-up text", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, { text: "ask jordan", cleaned_text: "Ask Jordan.", duration_seconds: 1 });
    stub.enqueue(200, { text: "ask jordan", cleaned_text: "", duration_seconds: 1 });

    const client = makeClient(stub);
    expect(await client.transcribe(wav, null, [], "t", undefined, cleanup)).toEqual({ text: "ask jordan", cleanedText: "Ask Jordan." });
    // A failed cleanup: empty, not null.
    expect(await client.transcribe(wav, null, [], "t", undefined, cleanup)).toEqual({ text: "ask jordan", cleanedText: "" });

    expect(stub.body(0).cleanup).toEqual(cleanup);
    expect(Object.keys(stub.body(0)).sort()).toEqual(["audio", "cleanup", "format"]);
  });

  test("rejects a cleaned text that is not a string", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, { text: "ask jordan", cleaned_text: 7 });
    expect((await backendError(makeClient(stub).transcribe(wav, null, [], "t", undefined, cleanup))).kind).toBe("invalidResponse");
  });

  /** The debug log's copy of the body shows the language, words and cleanup variables sent, beside
   * the audio's size. */
  test("the logged body shows the language, the words and the cleanup", () => {
    expect(TranscriptionClient.loggedBody(12, "ko", [])).toContain(`"language":"ko"`);
    expect(TranscriptionClient.loggedBody(12, null, [])).not.toContain("language");
    expect(TranscriptionClient.loggedBody(12, null, ["Xyvora"])).toContain(`"vocabulary":["Xyvora"]`);
    expect(TranscriptionClient.loggedBody(12, null, [])).not.toContain("vocabulary");
    expect(TranscriptionClient.loggedBody(12, null, [], cleanup)).toContain(`"window_title":"Weekly sync"`);
    expect(TranscriptionClient.loggedBody(12, null, [])).not.toContain("cleanup");
  });

  test.each([
    [401, "invalid_token", "unauthorized", undefined],
    [402, "no_active_subscription", "subscriptionRequired", undefined],
    [403, "consent_required", "accountSetupRequired", undefined],
    [403, "Access denied", "accessDenied", undefined],
    [429, "rate_limited", "rateLimited", undefined],
    [400, "audio_too_large", "recordingTooLong", undefined],
    [502, "transcription_failed", "failed", 502],
  ])("maps HTTP %i %s", async (status, code, kind, failedStatus) => {
    const stub = new StubTransport();
    stub.enqueue(status, { error: code });
    const error = await backendError(makeClient(stub).transcribe(wav, null, [], "t"));
    expect([error.kind, error.status]).toEqual([kind, failedStatus]);
  });

  test("rejects a response without text", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, { unexpected: true });
    expect((await backendError(makeClient(stub).transcribe(wav, null, [], "t"))).kind).toBe("invalidResponse");
  });

  /** A long recording in one piece: base64 in chunks matches Node's own encoder. */
  test("encodes a long recording whole", () => {
    const bytes = new Uint8Array(100_003).map((_, index) => (index * 7) % 256);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("withFreshToken", () => {
  /** An expired token gets exactly one retry, with a force-refreshed token. */
  test("retries once with a refreshed token after a 401", async () => {
    const backend = new StubTransport();
    backend.enqueue(401, { error: "invalid_token" });
    backend.enqueue(200, { text: "Retried." });
    const auth = new StubTransport();
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-2", refresh: "refresh-2" }));
    const account = signedIn(auth);
    const client = makeClient(backend);

    const transcription = await withFreshToken(account, Fixtures.userId, (token) => client.transcribe(wav, null, [], token));

    expect(transcription.text).toBe("Retried.");
    expect(backend.authorizations).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(auth.requests).toHaveLength(1);
  });

  test("does not retry other failures", async () => {
    const backend = new StubTransport();
    backend.enqueue(402, { error: "no_active_subscription" });
    const auth = new StubTransport();
    const account = signedIn(auth);
    const client = makeClient(backend);

    const error = await backendError(withFreshToken(account, Fixtures.userId, (token) => client.transcribe(wav, null, [], token)));

    expect(error.kind).toBe("subscriptionRequired");
    expect(backend.requests).toHaveLength(1);
    expect(auth.requests).toHaveLength(0);
  });

  test("signed out fails without calling the backend", async () => {
    const backend = new StubTransport();
    const account = signedIn(new StubTransport(), null);
    const client = makeClient(backend);

    const error = await backendError(withFreshToken(account, Fixtures.userId, (token) => client.transcribe(wav, null, [], token)));

    expect(error.kind).toBe("unauthorized");
    expect(backend.requests).toHaveLength(0);
  });

  /** A refused request can finish after sign-out or an account switch. The retry must report an
   * ended session, not another backend failure, and must never send the recording again. */
  test.each([false, true])("a session change during the request rejects the retry as unauthorized (switch account: %s)", async (switchAccount) => {
    const backend = new StubTransport();
    backend.enqueue(401, { error: "invalid_token" });
    backend.enqueue(200, { text: "Retried." });
    const auth = new StubTransport();
    if (switchAccount) {
      auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b", refresh: "refresh-b", userId: "user-2" }));
      auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b2", refresh: "refresh-b2", userId: "user-2" }));
    }
    const account = signedIn(auth);
    const client = makeClient(backend);
    backend.gate = async () => {
      account.signOut();
      if (switchAccount) await account.verify(Fixtures.email, "123456");
    };

    const error = await backendError(withFreshToken(account, Fixtures.userId, (token) => client.transcribe(wav, null, [], token)));

    expect(error.kind).toBe("unauthorized");
    expect(backend.authorizations).toEqual(["Bearer access-1"]);
    expect(account.session?.userId ?? null).toBe(switchAccount ? "user-2" : null);
  });
});
