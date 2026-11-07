// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The types of `document.mjs`, for the tests that import it.
export type Page = "codemirror" | "compose";
export type Size = "short" | "long";
export interface Case { name: string; size: Size; line: number; from: number; to: number }
export const pageLines: Record<Size, number>;
export function latexLine(index: number): string;
export function composeRuns(index: number): { text: string; bold?: boolean }[];
export function lines(page: Page, size: Size): string[];
export function cases(page: Page): Case[];
