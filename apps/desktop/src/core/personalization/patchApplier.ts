// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `text` with the characters models and keyboards vary in made plain, as Thunderbird's
 * `normalizeUnicode`: NFKC; a dash that starts a line (after its indentation) a hyphen, so it
 * reads as a bullet (a dash within a line is left as written); curly quotes and primes straight;
 * fullwidth square brackets plain; other spaces a space; an ellipsis three dots. */
export function normalizeUnicode(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(^|\n)([ \t]*)[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "$1$2-")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2032\u2035]/g, "'")
    .replace(/\u3010/g, "[")
    .replace(/\u3011/g, "]")
    .replace(/[\u00A0\u202F\u2007\u2008\u2009\u200A\u200B\u2028\u2029\u205F\u3000]/g, " ")
    .replace(/\u2026/g, "...");
}
