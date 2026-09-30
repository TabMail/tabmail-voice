// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon

/// The language a dictation is transcribed in: the language of the keyboard input source active at
/// key-down (ADR-DESK-019). The backend picks the speech-to-text model by it.
enum KeyboardLanguage {
    /// The first of an input source's languages (its own; a U.S. layout lists English first, then
    /// every other language it can type), reduced to its ISO-639-1 primary subtag (`zh-Hans` → `zh`).
    /// Nil when the source has no languages or the first has no two-letter code (`yue`), which is what
    /// the backend accepts.
    static func code(forSourceLanguages languages: [String]) -> String? {
        guard let first = languages.first,
              let primary = first.split(whereSeparator: { $0 == "-" || $0 == "_" }).first?.lowercased(),
              primary.count == 2, primary.allSatisfy({ ("a"..."z").contains($0) }) else { return nil }
        return primary
    }

    /// The active keyboard input source's language (Text Input Sources are read on the main thread).
    @MainActor
    static func current() -> String? {
        let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
        guard let property = TISGetInputSourceProperty(source, kTISPropertyInputSourceLanguages) else { return nil }
        let languages = Unmanaged<CFArray>.fromOpaque(property).takeUnretainedValue() as? [String] ?? []
        return code(forSourceLanguages: languages)
    }
}
