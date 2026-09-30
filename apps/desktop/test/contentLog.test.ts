// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "vitest";
import { BackendLog, CompletionsClient, type CompletionsMessage, TranscriptionClient } from "../src/core/backend.js";
import { block, configureLog, isDebugLogging, log, type LogLevel, setDebugMode } from "../src/core/log.js";
import { type ScreenContext, ScreenContextProbe } from "../src/core/screenContext.js";
import { charCount } from "../src/core/text.js";
import { Fixtures, loggedContent, StubTransport } from "./support.js";

const baseURL = "https://api.example.com";

function screen(overrides: Partial<ScreenContext> = {}): ScreenContext {
  return {
    appName: "Example Notes",
    bundleID: "com.example.notes",
    windowTitle: null,
    host: null,
    terminalProgram: null,
    focusedRole: null,
    textBeforeCaret: "Dear Alex,",
    selectedText: "",
    textAfterCaret: "",
    renderedText: "» Dear Alex,‸",
    summary: "1 block",
    logDescription: "app Example Notes (com.example.notes)\n--- visible text ---\n» Dear Alex,‸",
    ...overrides,
  };
}

afterEach(() => configureLog({ isDebugBuild: false, sinks: { error: () => {} } }));

/** The debug log file's content entries (ADR-DESK-015): requests to the backend and their replies
 * in full, never an access token or audio. */
describe("content log", () => {
  /** The whole point: in a debug build an entry reaches the log file, as a named block. */
  test("content is written to the log file in debug builds only", () => {
    const lines: [LogLevel, string][] = [];
    const sinks = { file: (level: LogLevel, text: string) => lines.push([level, text]), error: () => {} };

    configureLog({ isDebugBuild: false, sinks });
    log.content("Transcript (dictation)", "hidden");
    log.debug("hidden too");
    configureLog({ isDebugBuild: true, sinks });
    log.content("Transcript (dictation)", "line one\nline two");

    expect(lines).toEqual([["CONTENT", "Transcript (dictation) (17 chars) >>>\nline one\nline two\n<<< Transcript (dictation)"]]);
  });

  /** A packaged build writes the whole debug log (debug lines, content, errors) while debug mode is
   * on, and nothing while it is off; a new configuration starts with it off. */
  test("a packaged build logs while debug mode is on", () => {
    const lines: [LogLevel, string][] = [];
    const sinks = { file: (level: LogLevel, text: string) => lines.push([level, text]), error: () => {} };
    configureLog({ isDebugBuild: false, sinks });

    log.debug("off");
    setDebugMode(true);
    expect(isDebugLogging()).toBe(true);
    log.debug("on");
    log.content("Transcript (dictation)", "said");
    log.error("failed");
    setDebugMode(false);
    expect(isDebugLogging()).toBe(false);
    log.debug("off again");
    setDebugMode(true);
    configureLog({ isDebugBuild: false, sinks });
    log.debug("reconfigured");

    expect(lines).toEqual([
      ["debug", "on"],
      ["CONTENT", "Transcript (dictation) (4 chars) >>>\nsaid\n<<< Transcript (dictation)"],
      ["ERROR", "failed"],
    ]);
  });

  /** Errors reach production observability in every build, and the file only in debug builds. */
  test("errors go to the error sink always and to the file in debug builds", () => {
    const errors: string[] = [];
    const lines: string[] = [];
    const sinks = { file: (_level: LogLevel, text: string) => lines.push(text), error: (text: string) => errors.push(text) };

    configureLog({ isDebugBuild: false, sinks });
    log.error("first");
    configureLog({ isDebugBuild: true, sinks });
    log.error("second");

    expect(errors).toEqual(["first", "second"]);
    expect(lines).toEqual(["second"]);
  });

  test("a completions call logs its request, variables and raw reply but not the token", async () => {
    const screenText = `## Inbox\n» Dear Alex,‸\n${"long screen line\n".repeat(2_000)}`;
    const message: CompletionsMessage = { role: "system", content: "system_prompt_example", vars: { screen_text: screenText, user_request: "reply to Alex" } };
    const stream = Fixtures.completionsStream(`{"assistant":"Composed reply.","thinking":""}`);
    const stub = new StubTransport();
    stub.enqueue(200, stream);
    const client = new CompletionsClient(baseURL, "1.0", stub.transport);

    const entries = await loggedContent(async () => {
      await client.complete(message, "secret-token-123");
    });

    expect(entries.map((entry) => entry.label)).toEqual([
      "Completions system_prompt_example request",
      "Completions system_prompt_example variables",
      "Completions system_prompt_example response",
    ]);
    const [request, variables, response] = entries.map((entry) => entry.text);
    expect(request?.startsWith("POST https://api.example.com/completions/chat\n")).toBe(true);
    expect(request).toContain(`Authorization: ${BackendLog.maskedAuthorization}`);
    expect(request).toContain("X-Client-Type: macos");
    // The body exactly as sent.
    expect(request?.endsWith(`\n\n${stub.requests[0]?.body}`)).toBe(true);
    // Every variable whole, its line breaks as they are.
    expect(variables).toContain(`--- screen_text (${charCount(screenText)} chars) ---\n${screenText}`);
    expect(variables).toContain("--- user_request (13 chars) ---\nreply to Alex");
    expect(response?.startsWith("HTTP 200\n")).toBe(true);
    expect(response?.endsWith(`\n\n${stream}`)).toBe(true);
    expect(entries.map((entry) => entry.text).join("\n")).not.toContain("secret-token-123");
  });

  test("a failed completions call still logs the reply", async () => {
    const stub = new StubTransport();
    stub.enqueue(502, { error: "upstream_failed" });
    const client = new CompletionsClient(baseURL, "1.0", stub.transport);

    const entries = await loggedContent(async () => {
      await client.complete({ role: "system", content: "p", vars: {} }, "t").catch(() => undefined);
    });

    expect(entries.at(-1)?.label).toBe("Completions p response");
    expect(entries.at(-1)?.text.startsWith("HTTP 502\n")).toBe(true);
    expect(entries.at(-1)?.text.endsWith(`{"error":"upstream_failed"}`)).toBe(true);
  });

  test("the warm-up logs its request and reply but not the token", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, { logged_in: true });
    const client = new TranscriptionClient(baseURL, "1.0", stub.transport);

    const entries = await loggedContent(async () => {
      await client.warmUp("secret-token-123");
    });

    expect(entries.map((entry) => entry.label)).toEqual(["Warm-up request", "Warm-up response"]);
    expect(entries[0]?.text.startsWith("GET https://api.example.com/whoami\n")).toBe(true);
    expect(entries[0]?.text).toContain(BackendLog.maskedAuthorization);
    expect(entries[1]?.text).toContain(`"logged_in":true`);
    expect(stub.requests[0]?.headers.Authorization).toBe("Bearer secret-token-123");
    expect(entries.map((entry) => entry.text).join("\n")).not.toContain("secret-token-123");
  });

  test("a transcription logs the reply but neither the audio nor the token", async () => {
    const flac = new TextEncoder().encode("fLaC-test-audio-that-must-not-be-logged");
    const audio = Buffer.from(flac).toString("base64");
    const stub = new StubTransport();
    stub.enqueue(200, { text: "Hello there." });
    const client = new TranscriptionClient(baseURL, "1.0", stub.transport);

    const entries = await loggedContent(async () => {
      await client.transcribe(flac, null, ["Xyvora"], "secret-token-123");
    });

    expect(entries.map((entry) => entry.label)).toEqual(["Transcription request", "Transcription response"]);
    const [request, response] = entries.map((entry) => entry.text);
    expect(request?.startsWith("POST https://api.example.com/dictation/transcribe\n")).toBe(true);
    expect(request).toContain(`<${flac.length} bytes of FLAC, not logged>`);
    expect(request).toContain(`"format":"flac"`);
    expect(request).toContain(`"vocabulary":["Xyvora"]`);
    expect(response).toContain(`"text":"Hello there."`);
    // The stub did receive the audio: the log left it out.
    expect(stub.requests[0]?.body).toContain(audio);
    const joined = entries.map((entry) => entry.text).join("\n");
    expect(joined).not.toContain(audio);
    expect(joined).not.toContain("secret-token-123");
  });

  test("a failed transcription still logs the reply", async () => {
    const stub = new StubTransport();
    stub.enqueue(502, { error: "transcription_failed" });
    const client = new TranscriptionClient(baseURL, "1.0", stub.transport);

    const entries = await loggedContent(async () => {
      await client.transcribe(new TextEncoder().encode("RIFF"), null, [], "t").catch(() => undefined);
    });

    expect(entries.map((entry) => entry.label)).toEqual(["Transcription request", "Transcription response"]);
    expect(entries.at(-1)?.text.startsWith("HTTP 502\n")).toBe(true);
    expect(entries.at(-1)?.text.endsWith(`{"error":"transcription_failed"}`)).toBe(true);
  });

  /** The screen read at key-down is logged whole as it is captured. */
  test("a screen read is logged as it is captured", async () => {
    const captured = screen();
    const probe = new ScreenContextProbe(() => true, () => Promise.resolve(captured));

    const entries = await loggedContent(async () => {
      await probe.capture();
    });

    expect(entries).toEqual([{ label: "ScreenContext", text: captured.logDescription }]);
  });

  test("the Authorization header is masked whatever its case", () => {
    const text = BackendLog.request({
      method: "POST",
      url: baseURL,
      headers: { authorization: "Bearer secret-token-123", "X-Client-Type": "macos" },
      body: "{}",
      timeout: 1,
    });

    expect(text).not.toContain("secret-token-123");
    expect(text).toContain(BackendLog.maskedAuthorization);
    expect(text).toContain("X-Client-Type: macos");
    expect(text.endsWith("\n\n{}")).toBe(true);
  });

  test("a response log carries its headers and whole body", () => {
    const body = "x".repeat(50_000);
    const text = BackendLog.response({ status: 200, headers: { "cf-ray": "abc123-SJC" }, body });

    expect(text.startsWith("HTTP 200\n")).toBe(true);
    expect(text).toContain("cf-ray: abc123-SJC");
    expect(text.endsWith(`\n\n${body}`)).toBe(true);
  });

  test("a block keeps its text whole between named lines", () => {
    expect(block("Transcript", "line one\nline two")).toBe("Transcript (17 chars) >>>\nline one\nline two\n<<< Transcript");
  });
});

describe("ScreenContextProbe", () => {
  test("without the Accessibility grant nothing is read", () => {
    let reads = 0;
    const probe = new ScreenContextProbe(() => false, () => {
      reads += 1;
      return Promise.resolve(screen());
    });

    expect(probe.capture()).toBeNull();
    expect(reads).toBe(0);
  });

  /** A failed or empty read is no context, never an error for the dictation. */
  test("a failed read is no context", async () => {
    const probe = new ScreenContextProbe(() => true, () => Promise.reject(new Error("helper gone")));
    expect(await probe.capture()).toBeNull();
    expect(await new ScreenContextProbe(() => true, () => Promise.resolve(null)).capture()).toBeNull();
  });

  /** Debug builds keep the newest capture for the debug window; an older read finishing later
   * does not replace it. */
  test("debug builds keep the latest capture only", async () => {
    configureLog({ isDebugBuild: true, sinks: { error: () => {} } });
    const reads: ((context: ScreenContext) => void)[] = [];
    const probe = new ScreenContextProbe(() => true, () => new Promise((resolve) => reads.push(resolve)));

    const older = probe.capture();
    const newer = probe.capture();
    reads[1]?.(screen({ appName: "Newer" }));
    await newer;
    reads[0]?.(screen({ appName: "Older" }));

    expect((await older)?.appName).toBe("Older");
    expect(probe.lastContext?.appName).toBe("Newer");
  });

  test("release builds keep no capture", async () => {
    const probe = new ScreenContextProbe(() => true, () => Promise.resolve(screen()));
    await probe.capture();
    expect(probe.lastContext).toBeNull();
  });
});
