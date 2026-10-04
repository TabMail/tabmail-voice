// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon

/// The language a dictation is transcribed in: the language of the keyboard input source active at
/// key-down (ADR-DESK-019). The backend picks the speech-to-text model by it.
enum KeyboardLanguage {
    /// Select only the input source's own language. Later entries describe other languages the
    /// layout can type. Application logic canonicalizes this raw locale on every platform.
    static func code(forSourceLanguages languages: [String]) -> String? {
        languages.first
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
