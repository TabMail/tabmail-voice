// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// The backend pass over a transcript: with what was on screen when the dictation started, it
/// fixes speech-recognition errors (names and terms shown on screen, capitalisation that doesn't
/// fit where the text lands) and changes nothing else. The instructions live in the backend
/// prompt `DictationConfig.cleanupPrompt`.
enum DictationCleanup {
    /// The transcript with its recognition errors fixed, requested under the account `userId` that
    /// transcribed it. When the cleanup fails for any reason, including that account no longer being
    /// signed in, the transcript as heard: a failed cleanup never costs the user their dictation
    /// (ADR-DESK-008).
    @MainActor
    static func cleanUp(_ transcript: String, context: ScreenContext?, client: CompletionsClient, account: AccountModel, userId: String?) async -> String {
        let message = message(dictation: transcript, context: context)
        let clock = ContinuousClock()
        let started = clock.now
        do {
            let text = try await DictationController.withFreshToken(account: account, userId: userId) { try await client.complete(message, accessToken: $0) }
                .trimmingCharacters(in: .whitespacesAndNewlines)
            Log.debug("DictationCleanup: cleaned up in \(clock.now - started) (\(transcript.count) → \(text.count) chars, screen text \(message.vars["screen_text"]?.count ?? 0) chars)")
            // The prompt never removes dictated words, so an empty reply is a malfunction.
            guard !text.isEmpty else {
                Log.error("DictationCleanup: empty reply; pasting the transcript as heard")
                return transcript
            }
            return text
        } catch {
            Log.error("DictationCleanup: failed after \(clock.now - started): \(type(of: error)); pasting the transcript as heard")
            return transcript
        }
    }

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
