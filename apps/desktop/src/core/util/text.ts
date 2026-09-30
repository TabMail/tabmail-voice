// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Whitespace and line breaks, as Swift's `.whitespacesAndNewlines` has them (NEL included). */
const edges = /^[\s\u0085]+|[\s\u0085]+$/g;

export function trimWhitespace(text: string): string {
  return text.replace(edges, "");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Characters as a reader counts them (grapheme clusters), for logs. */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of graphemes.segment(text)) count += 1;
  return count;
}

/** Standard base64 of `bytes`, in chunks so a long recording never builds one huge argument list. */
export function base64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}
