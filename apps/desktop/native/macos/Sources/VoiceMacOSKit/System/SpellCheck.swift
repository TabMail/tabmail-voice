// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import VoiceHelperSupport

/// Which words are everyday words of the user's languages, by the system's spell checker: the screen
/// terms' test (ADR-DESK-038, amended 2026-11-04). The shared core picks which of the checker's
/// languages serves each of the user's, and the choice is made again without one that knows the
/// core's word in no language (`madeUp`, amended 2026-11-05); the words are checked as given (the app
/// sends them in lowercase). The checker is asked from this actor only, off the main thread.
actor SpellCheck {
    static let shared = SpellCheck()

    /// The checker's languages, and whether the one named knows a word: the system's, or a test's.
    private let available: @Sendable () -> [String]
    private let knows: @Sendable (_ word: String, _ language: String) -> Bool

    init(
        available: @escaping @Sendable () -> [String] = { NSSpellChecker.shared.availableLanguages },
        knows: @escaping @Sendable (_ word: String, _ language: String) -> Bool = { word, language in
            NSSpellChecker.shared.checkSpelling(of: word, startingAt: 0, language: language, wrap: false, inSpellDocumentWithTag: 0, wordCount: nil).location == NSNotFound
        }
    ) {
        self.available = available
        self.knows = knows
    }

    /// The `words` a dictionary serving one of `languages` (tags, which the shared core checks) has,
    /// the languages none serves, and how many dictionaries answered:
    /// `{"known":[word…],"unavailable":[tag…],"dictionaries":count}`.
    func known(languages: JSON, words: [String]) throws -> JSON {
        var available = self.available()
        var chosen: JSON
        var dictionaries: [String]
        var refused: [String]
        // Each pass leaves out one more of the checker's languages, so it ends.
        repeat {
            let choice: JSON = .object(["languages": languages, "available": .array(available.map(JSON.string))])
            chosen = try JSONDecoder().decode(JSON.self, from: Redactor.request(JSONEncoder().encode(choice), operation: .dictionaries))
            dictionaries = chosen["dictionaries"]?.array?.compactMap(\.string) ?? []
            guard let madeUp = chosen["madeUp"]?.string else { throw HelperError("the shared core named no word in no language") }
            refused = dictionaries.filter { knows(madeUp, $0) }
            available.removeAll(where: refused.contains)
        } while !refused.isEmpty
        let known = words.filter { word in dictionaries.contains { knows(word, $0) } }
        return ["known": .array(known.map(JSON.string)), "unavailable": chosen["unavailable"] ?? [], "dictionaries": .number(Double(dictionaries.count))]
    }
}
