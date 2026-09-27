// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// Writes new text at the caret, as asked; offered only when nothing is selected.
struct ComposeTool: DesktopTool {
    let displayName = "Compose"
    let symbolName = "square.and.pencil"
    let prompt = DictationConfig.agentComposePrompt

    /// The screen, plus the program running in a terminal, so a command comes out as that program takes it.
    func variables(request: String, context: ScreenContext?) -> [String: String] {
        var vars = screenVariables(request: request, context: context)
        vars["terminal_program"] = context?.terminalProgram ?? ""
        return vars
    }

    /// Pastes at the caret.
    func deliver(_ text: String, in context: ToolContext) async throws {
        try await context.pasteIntoTargetApp(text)
    }
}
