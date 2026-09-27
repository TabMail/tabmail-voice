// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// Rewrites the selected text in place, as asked; offered only when text is selected.
struct EditTool: DesktopTool {
    let displayName = "Edit"
    let symbolName = "pencil"
    let prompt = DictationConfig.agentEditPrompt

    /// With the selection's own leading and trailing blank space, so replacing a whole line keeps its
    /// line break.
    func fitted(_ text: String, context: ScreenContext?) -> String {
        Self.fitted(text, toSelection: DesktopAgent.selection(in: context))
    }

    /// Pastes over the selection, which the non-activating overlay leaves in place.
    func deliver(_ text: String, in context: ToolContext) async throws {
        try await context.pasteIntoTargetApp(text)
    }

    /// `text` with the leading and trailing blank space of `selection` in place of its own.
    static func fitted(_ text: String, toSelection selection: String) -> String {
        let leading = selection.prefix(while: \.isWhitespace)
        let trailing = selection.reversed().prefix(while: \.isWhitespace).reversed()
        return leading + text.trimmingCharacters(in: .whitespacesAndNewlines) + String(trailing)
    }
}
