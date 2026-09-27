// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// Sends a mail or calendar request, restated as a chat message, to TabMail's chat in Thunderbird;
/// offered only when there is an email app for it (ADR-DESK-014).
struct ThunderbirdTool: DesktopTool {
    let displayName = "Thunderbird"
    let symbolName = "envelope"
    let prompt = DictationConfig.agentThunderbirdPrompt

    /// Hands the message to the Thunderbird connector, for the email app the dictation started with.
    /// Not held to the app in front at key-down: the relay brings Thunderbird to the front itself, and
    /// has its own focus checks.
    func deliver(_ text: String, in context: ToolContext) async throws {
        try await context.thunderbird.send(text, to: context.settings.emailApp)
    }
}
