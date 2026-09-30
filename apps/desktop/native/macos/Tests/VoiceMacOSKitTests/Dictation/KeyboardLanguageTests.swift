// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon
import Testing
@testable import VoiceMacOSKit

/// An input source's languages → the language a dictation is sent with.
struct KeyboardLanguageTests {
    @Test(arguments: [
        // Korean 2-Set reports only Korean.
        (["ko"], "ko"),
        // The U.S. layout lists English first, then every language it can type (96 on macOS 26).
        (["en", "af", "asa", "bem", "ca"], "en"),
        // A script or region variant → its primary subtag.
        (["zh-Hans"], "zh"),
        (["pt_BR"], "pt"),
        (["sr-Latn-RS"], "sr"),
        (["EN"], "en"),
    ])
    func takesTheFirstLanguagesPrimarySubtag(languages: [String], expected: String) {
        #expect(KeyboardLanguage.code(forSourceLanguages: languages) == expected)
    }

    /// No two-letter code to send: the backend accepts only ISO-639-1, so the dictation sends none.
    @Test(arguments: [[], ["yue"], ["fil", "en"], [""], ["e1"], ["-"]])
    func sendsNoneWithoutATwoLetterCode(languages: [String]) {
        #expect(KeyboardLanguage.code(forSourceLanguages: languages) == nil)
    }

    /// The live read: the language the active keyboard input source reports, read here without
    /// `KeyboardLanguage`.
    @MainActor
    @Test func readsTheActiveKeyboardsLanguage() throws {
        let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
        let property = try #require(TISGetInputSourceProperty(source, kTISPropertyInputSourceLanguages))
        let first = (Unmanaged<CFArray>.fromOpaque(property).takeUnretainedValue() as? [String])?.first ?? ""
        let primary = String(first.prefix { $0 != "-" && $0 != "_" }).lowercased()
        let expected = primary.utf8.count == 2 && primary.utf8.allSatisfy({ (97...122).contains($0) }) ? primary : nil
        #expect(KeyboardLanguage.current() == expected, "the keyboard's first language is \(first)")
    }
}
