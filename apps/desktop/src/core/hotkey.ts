// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The key held to dictate. */
export type DictationHotkey = "rightOption" | "function";

export const dictationHotkeys: readonly DictationHotkey[] = ["rightOption", "function"];

export const defaultHotkey: DictationHotkey = "rightOption";

export function isDictationHotkey(value: unknown): value is DictationHotkey {
  return typeof value === "string" && (dictationHotkeys as readonly string[]).includes(value);
}

export const hotkeyNames: Record<DictationHotkey, { displayName: string; keycap: string }> = {
  rightOption: { displayName: "Right Option (⌥)", keycap: "right ⌥" },
  function: { displayName: "Fn / Globe (🌐)", keycap: "fn" },
};

/** What the speech is for: text to insert, or a request for the agent to carry out. Space, pressed
 * while the hotkey is held, switches between them. */
export type DictationMode = "dictation" | "agent";

export function toggled(mode: DictationMode): DictationMode {
  return mode === "dictation" ? "agent" : "dictation";
}

/** What the platform's hotkey helper recognised (the push-to-talk gesture runs beside the key tap,
 * so a key that starts a dictation is swallowed before any app sees it). */
export type HotkeyAction = "start" | "startHandsFree" | "finish" | "cancel" | "toggleMode";

export const hotkeyActions: readonly HotkeyAction[] = ["start", "startHandsFree", "finish", "cancel", "toggleMode"];

export function isHotkeyAction(value: unknown): value is HotkeyAction {
  return typeof value === "string" && (hotkeyActions as readonly string[]).includes(value);
}
