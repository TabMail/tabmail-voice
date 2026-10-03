// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.


export type BackendErrorKind =
  | "unauthorized"
  | "subscriptionRequired"
  | "accountSetupRequired"
  | "accessDenied"
  | "rateLimited"
  | "recordingTooLong"
  | "failed"
  | "invalidResponse";

const messages: Record<BackendErrorKind, string> = {
  unauthorized: "Your TabMail session has ended. Sign in again in Settings.",
  subscriptionRequired: "Dictation needs an active TabMail subscription.",
  accountSetupRequired: "Finish setting up your TabMail account at tabmail.ai.",
  accessDenied: "This account can't use this TabMail server.",
  rateLimited: "Too many dictations right now. Try again in a moment.",
  recordingTooLong: "That recording was too long to transcribe.",
  failed: "Dictation failed. Please try again.",
  invalidResponse: "TabMail returned an unexpected response.",
};

/** A failed TabMail backend call; its message is what the overlay shows for it. */
export class BackendError extends Error {
  constructor(
    readonly kind: BackendErrorKind,
    /** For `failed`: the HTTP status. */
    readonly status?: number,
  ) {
    super(messages[kind]);
    this.name = "BackendError";
  }

  /** From an HTTP error status and the `error` code of its JSON body. */
  static fromStatus(status: number, code: string | undefined): BackendError {
    if (status === 401) return new BackendError("unauthorized");
    if (status === 402) return new BackendError("subscriptionRequired");
    if (status === 403) return new BackendError(code === "consent_required" ? "accountSetupRequired" : "accessDenied");
    // The speech model's rate limit, which the backend already retried for its 30 s window (backend
    // ADR-022): its failure, not this account's limit.
    if (status === 429 && code === "transcription_rate_limited") return new BackendError("failed", status);
    if (status === 429) return new BackendError("rateLimited");
    if (status === 400 && code === "audio_too_large") return new BackendError("recordingTooLong");
    return new BackendError("failed", status);
  }

  /** For the log: the case, never user content. */
  get description(): string {
    return this.kind === "failed" ? `BackendError.failed(status: ${this.status})` : `BackendError.${this.kind}`;
  }
}

/** The `error` code of an HTTP error's JSON body. */
export function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // A proxy's plain-text error: no code.
  }
  return undefined;
}
