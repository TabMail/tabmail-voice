// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A tool the Answer prompt's model can call that runs on this computer (a calendar read, a reminder
 * created, a file found), as the iOS app's `ToolRegistry` tools are. Its definition, the JSON the
 * model sees, lives in the backend's tool registry for this client under the same `name`; the app
 * lists the names it can run in each Answer request's `available_tools` (ADR-DESK-023).
 */
export interface LoopTool {
  /** The function name, as in the backend's registry. */
  readonly name: string;
  /** What the chat window says while it runs ("Checking your calendar"). */
  readonly progressLabel: string;
  /** What the chat window asks before the tool sends or creates anything ("Add “Launch review” to
   * your calendar on Friday at 10:00?"); null for a tool that only reads. The tool runs only if the
   * user confirms (owner, 2026-09-26: send or create = confirm first, always). */
  confirmation(args: Record<string, unknown>): string | null;
  /** Runs the tool; the result is what the model reads next. Throws when it can't: the model is told
   * why. */
  run(args: Record<string, unknown>): Promise<string>;
}

/** Whether `value`, parsed JSON, is an object (not an array or null). */
export function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
