// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon
import Testing
@testable import VoiceMacOSKit

/// Native acquisition preserves the first source locale for shared application normalization.
struct KeyboardLanguageTests {
    @Test(arguments: [
        (["ko"], "ko"),
        (["en", "af", "asa"], "en"),
        (["zh-Hans"], "zh-Hans"),
        (["pt_BR"], "pt_BR"),
        (["EN"], "EN"),
        (["fil", "en"], "fil"),
    ])
    func preservesTheFirstSourceLanguage(languages: [String], expected: String) {
        #expect(KeyboardLanguage.code(forSourceLanguages: languages) == expected)
    }

    @Test func noSourceLanguages() {
        #expect(KeyboardLanguage.code(forSourceLanguages: []) == nil)
    }

    @Test func anUnspecifiedSourceDoesNotInventOrFallBackToALanguage() {
        // TIS uses an empty first entry for sources without an intended language.
        #expect(KeyboardLanguage.code(forSourceLanguages: [""]) == "")
        #expect(KeyboardLanguage.code(forSourceLanguages: ["", "en"]) == "")
    }

    @MainActor
    @Test func readsTheActiveKeyboardsLanguage() throws {
        let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
        let property = try #require(TISGetInputSourceProperty(source, kTISPropertyInputSourceLanguages))
        let first = (Unmanaged<CFArray>.fromOpaque(property).takeUnretainedValue() as? [String])?.first
        #expect(KeyboardLanguage.current() == first)
    }
}
