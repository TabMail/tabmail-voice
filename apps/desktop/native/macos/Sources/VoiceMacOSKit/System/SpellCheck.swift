// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import VoiceHelperSupport

/// Which words are everyday words of the user's languages, by the system's spell checker: the screen
/// terms' test (ADR-DESK-038, amended 2026-11-04). The shared core picks which of the checker's
/// languages serves each of the user's; the words are checked as given (the app sends them in
/// lowercase). The checker is asked from this actor only, off the main thread.
actor SpellCheck {
    static let shared = SpellCheck()

    /// The `words` a dictionary serving one of `languages` (tags, which the shared core checks) has,
    /// and the languages none serves: `{"known":[word…],"unavailable":[tag…]}`.
    func known(languages: JSON, words: [String]) throws -> JSON {
        let checker = NSSpellChecker.shared
        let choice: JSON = .object(["languages": languages, "available": .array(checker.availableLanguages.map(JSON.string))])
        let chosen = try JSONDecoder().decode(JSON.self, from: Redactor.request(JSONEncoder().encode(choice), operation: .dictionaries))
        let dictionaries = chosen["dictionaries"]?.array?.compactMap(\.string) ?? []
        let known = words.filter { word in
            dictionaries.contains { language in
                checker.checkSpelling(of: word, startingAt: 0, language: language, wrap: false, inSpellDocumentWithTag: 0, wordCount: nil).location == NSNotFound
            }
        }
        return ["known": .array(known.map(JSON.string)), "unavailable": chosen["unavailable"] ?? []]
    }
}
