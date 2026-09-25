// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// The backend pass over a transcript: with what was on screen when the dictation started, it
/// fixes speech-recognition errors (names and terms shown on screen, capitalisation that doesn't
/// fit where the text lands) and changes nothing else. The instructions live in the backend
/// prompt `DictationConfig.cleanupPrompt`.
enum DictationCleanup {
    /// The prompt and its variables. Anything not known is sent empty; the prompt reads an empty
    /// field as unknown.
    static func message(dictation: String, context: ScreenContext?) -> CompletionsMessage {
        CompletionsMessage(role: "system", content: DictationConfig.cleanupPrompt, vars: [
            "dictation": dictation,
            "app_name": context?.appName ?? "",
            "web_host": context?.host ?? "",
            "terminal_program": context?.terminalProgram ?? "",
            "window_title": context?.windowTitle ?? "",
            "screen_text": context?.renderedText() ?? "",
        ])
    }
}
