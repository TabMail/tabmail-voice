// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Native adapters supply the active input source's locale. All platforms use the same
 * canonicalization and the transcription endpoint's two-letter language contract. */
export function keyboardLanguageCode(locale: unknown): string | null {
  if (typeof locale !== "string") return null;
  try {
    const primary = new Intl.Locale(locale.replaceAll("_", "-")).language;
    return /^[a-z]{2}$/u.test(primary) ? primary : null;
  } catch { return null; }
}
