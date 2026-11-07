// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The types of `checks.mjs`, for the tests that import it.
import type { Case } from "./document.mjs";

export interface Rect { x: number; y: number; width?: number; height: number }
export interface PageReport {
  selected: string;
  caret: { x: number; y: number; height: number };
  start?: { x: number; y: number; height: number };
  scale: number;
  screen: { x: number; y: number; frameX: number; frameY: number };
}
export interface ScreenRead { textBeforeCaret?: unknown; selectedText?: unknown; textAfterCaret?: unknown; bundleID?: unknown; appName?: unknown }
export const anchorTolerance: { between: number; onScreen: number };
export const anchorHeightRatio: { min: number; max: number };
export const knownFailures: Record<string, Record<string, number>>;
export const sometimesFailing: Set<number>;
export const browserNames: Record<"firefox" | "chrome" | "edge", RegExp>;
export function checkIdentity(browser: "firefox" | "chrome" | "edge", read: ScreenRead | null): string[];
export function checkScreen(lines: string[], testCase: Case, read: ScreenRead | null): string[];
export function checkField(lines: string[], testCase: Case, reply: { value?: unknown } | null): string[];
export function checkAnchors(entries: { name: string; report: PageReport; anchor: Rect | null }[], options: { onScreen: boolean }): { name: string; why: string }[];
export function verdict(platform: string, read: string, wrong: string[]): "pass" | "fail" | "known" | "fixed";
