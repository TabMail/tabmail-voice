// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The user's languages the system has no spelling dictionary for (the main helper's `knownWords`
 * reply, `unavailable`; ADR-DESK-038, amended 2026-11-04). Screen terms are the words no dictionary of
 * the user's languages knows, so without one every capitalized word on screen in that language counts
 * as a term: the menu says so, and on Windows and Linux how to install one from the system.
 */

/** A language the system has no spelling dictionary for, by its language subtag ("ko") and its name in
 * English ("Korean"). */
export interface MissingDictionary {
  language: string;
  name: string;
}

/** Languages written without spaces between words: screen terms are split at spaces, so a spelling
 * dictionary would not tell their words apart, and none is asked for (owner, 2026-11-04: Chinese and
 * Japanese are left for now). */
const writtenWithoutSpaces: ReadonlySet<string> = new Set(["zh", "ja", "th", "lo", "km", "my"]);

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/** The languages of `unavailable` (tags as the system names its preferred languages: "ko-KR",
 * "pt_BR.UTF-8") to warn about, each once, in their order. A region is not named: the helper reports a
 * tag only when no dictionary of its language at all is there. */
export function missingDictionaries(unavailable: readonly string[]): MissingDictionary[] {
  const missing: MissingDictionary[] = [];
  for (const tag of unavailable) {
    const language = tag.split(/[-_.@]/)[0]?.toLowerCase() ?? "";
    if (!/^[a-z]{2,3}$/.test(language) || writtenWithoutSpaces.has(language) || missing.some((known) => known.language === language)) continue;
    let name: string | undefined;
    try {
      name = languageNames.of(language);
    } catch {
      name = undefined;
    }
    missing.push({ language, name: name ?? language });
  }
  return missing;
}

/** Whether the menu marks the icon for a missing dictionary on `platform` (`process.platform`): only where
 * the user can install one. macOS has spell checkers for the languages it has, and none to add. */
export function canInstallDictionary(platform: string): boolean {
  return platform === "win32" || platform === "linux";
}

/** The menu item for `missing`: on Windows and Linux it tells how to install the dictionary; on macOS a
 * line saying there is none. */
export function missingDictionaryLabel(missing: MissingDictionary, platform: string): string {
  return canInstallDictionary(platform) ? `Install a Spelling Dictionary for ${missing.name}…` : `No macOS spelling dictionary for ${missing.name}`;
}

/** The tooltip while a dictionary is missing and can be installed. */
export const missingDictionaryToolTip = "TabMail Voice needs a spelling dictionary";

/** What the user is told when `missing`'s dictionary is not installed, and how to install it on
 * `platform` (Windows or Linux). */
export function missingDictionaryNotice(missing: MissingDictionary, platform: string): { message: string; detail: string } {
  const why = `TabMail Voice tells names on your screen from everyday words with your system's spelling dictionaries. Without one for ${missing.name}, every capitalized word in ${missing.name} is taken for a name.`;
  const steps = platform === "win32"
    ? `To install it, open Settings > Time & language > Language & region, add ${missing.name} under Preferred languages, and keep its typing features.`
    : `To install it on Ubuntu, open Settings > System > Region & Language > Manage Installed Languages and install ${missing.name}. Or install its Hunspell dictionary from a terminal: find it with \`apt search hunspell-${missing.language}\`.`;
  return {
    message: `Your system has no spelling dictionary for ${missing.name}.`,
    detail: `${why}\n\n${steps}\n\nTabMail Voice uses it from your next dictation. If this item is still in its menu then, quit TabMail Voice and open it again.`,
  };
}
