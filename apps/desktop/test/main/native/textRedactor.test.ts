// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test, vi } from "vitest";
import { redactionTextMaxBytes, textRedactionTimeout } from "../../../src/core/config.js";
import { NativeTextRedactor } from "../../../src/main/native/textRedactor.js";
import { HelperError, type HelperClient } from "../../../src/main/native/helperClient.js";
import { CancellationError } from "../../../src/core/util/timeout.js";

const text = "token=syntheticPrivate123";
const signal = () => new AbortController().signal;
function redactor(request: ReturnType<typeof vi.fn>) {
  return new NativeTextRedactor({ request } as Pick<HelperClient, "request">);
}

test("returns only the native redacted result without queuing across restart", async () => {
  const request = vi.fn().mockResolvedValue({ text: "token=[redacted]" });
  expect(await redactor(request).redact(text, signal())).toBe("token=[redacted]");
  expect(request).toHaveBeenCalledExactlyOnceWith("redactText", { text }, textRedactionTimeout);
});

test.each(["exited", "timeout", "failed"] as const)("%s refuses without exposing input or helper error details", async (kind) => {
  const request = vi.fn().mockRejectedValue(new HelperError(kind, "redactText", text));
  await expect(redactor(request).redact(text, signal())).rejects.toThrow(/^Document text could not be safely redacted\.$/u);
});

test("the surrounding text is sent for recognition and only the text itself comes back", async () => {
  const request = vi.fn().mockResolvedValue({ text: "[redacted] Public." });
  const context = { before: "token=", after: " Later." };
  expect(await redactor(request).redact("syntheticPrivate123. Public.", signal(), context)).toBe("[redacted] Public.");
  expect(request).toHaveBeenCalledExactlyOnceWith("redactText", { text: "syntheticPrivate123. Public.", ...context }, textRedactionTimeout);
});

test("the surrounding text counts toward the redaction limit", async () => {
  const request = vi.fn();
  const half = "x".repeat(redactionTextMaxBytes / 2);
  await expect(redactor(request).redact("y", signal(), { before: half, after: half })).rejects.toThrow("limit");
  expect(request).not.toHaveBeenCalled();
});

test.each([null, {}, { text: null }, { text: 1 }, { text: "x".repeat(1024 * 1024 + 1) }])("malformed result is a refusal", async (reply) => {
  await expect(redactor(vi.fn().mockResolvedValue(reply)).redact(text, signal())).rejects.toThrow("could not be safely redacted");
});

test("oversized UTF-8 is refused before it reaches the helper", async () => {
  const request = vi.fn();
  await expect(redactor(request).redact("😀".repeat(redactionTextMaxBytes / 4 + 1), signal())).rejects.toThrow("limit");
  expect(request).not.toHaveBeenCalled();
});

test("cancellation returns promptly and ignores a later native reply", async () => {
  let complete!: (value: unknown) => void;
  const request = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
  const controller = new AbortController();
  const result = redactor(request).redact(text, controller.signal);
  controller.abort();
  await expect(result).rejects.toBeInstanceOf(CancellationError);
  complete({ text: "token=[redacted]" });
  await Promise.resolve();
  await expect(redactor(request).redact(text, controller.signal)).rejects.toBeInstanceOf(CancellationError);
  expect(request).toHaveBeenCalledTimes(1);
});
