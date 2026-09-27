// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// What agent mode can do with a spoken request: the registry of its tools, as the Thunderbird
/// add-on's `chat/tools/core.js` and the iOS app's `AgentToolRouter` are for theirs. The raw value is
/// the name the agent answers with; each tool is implemented in its own file under `Tools/`, and a
/// tool that hands the request to another app goes through that app's connector under `Connectors/`
/// (ADR-DESK-020). Each tool is one backend prompt; its bubble shows above the pill while agent mode
/// listens, and its border circles while it runs. Edit and Compose are never offered together: the
/// selection decides which (`DesktopAgent.writingTool(for:)`).
enum AgentTool: String, CaseIterable, Sendable {
    /// Rewrites the selected text in place, as asked (`EditTool`).
    case edit
    /// Writes new text at the caret, as asked (`ComposeTool`).
    case compose
    /// Sends a mail or calendar request to TabMail's chat in Thunderbird (`ThunderbirdTool`).
    case thunderbird

    var implementation: any DesktopTool {
        switch self {
        case .edit: EditTool()
        case .compose: ComposeTool()
        case .thunderbird: ThunderbirdTool()
        }
    }

    var displayName: String { implementation.displayName }

    /// SF Symbol shown in the tool's bubble, unless it shows the app's icon (Thunderbird's).
    var symbolName: String { implementation.symbolName }

    var prompt: String { implementation.prompt }
}

/// One of agent mode's tools: the backend prompt that writes its text from the spoken request and the
/// screen, and where that text goes.
protocol DesktopTool: Sendable {
    var displayName: String { get }
    var symbolName: String { get }
    /// The backend prompt that writes the tool's text.
    var prompt: String { get }
    /// The prompt's variables. Every variable is sent, empty when unknown: the backend leaves a
    /// missing one in the prompt as written.
    func variables(request: String, context: ScreenContext?) -> [String: String]
    /// The text the prompt wrote (trimmed, not empty), ready to deliver.
    func fitted(_ text: String, context: ScreenContext?) -> String
    /// Puts the text where the tool puts it. Throws when it can't, and then nothing is put anywhere.
    @MainActor
    func deliver(_ text: String, in context: ToolContext) async throws
}

extension DesktopTool {
    func variables(request: String, context: ScreenContext?) -> [String: String] {
        screenVariables(request: request, context: context)
    }

    func fitted(_ text: String, context: ScreenContext?) -> String { text }

    /// The variables every tool's prompt gets: the request, the app, and the screen read at key-down.
    func screenVariables(request: String, context: ScreenContext?) -> [String: String] {
        [
            "app_name": context?.appName ?? "",
            "web_host": context?.host ?? "",
            "window_title": context?.windowTitle ?? "",
            "screen_text": context?.renderedText() ?? "",
            "selected_text": DesktopAgent.selection(in: context),
            "user_request": request,
        ]
    }
}

/// What a tool delivers its text with, for one agent request.
@MainActor
struct ToolContext {
    /// The settings the dictation started with (ADR-DESK-017); a tool reads no others.
    let settings: DictationSettings
    let inserter: TextInserter
    /// Whether the app in front at key-down still is.
    let isTargetAppFrontmost: @MainActor () -> Bool
    let thunderbird: ThunderbirdRelay

    /// Pastes `text` into the app the user spoke over. The request may have taken long enough for the
    /// user to move on: the text belongs in that app, and is pasted nowhere else.
    func pasteIntoTargetApp(_ text: String) async throws {
        guard isTargetAppFrontmost() else { throw DesktopAgent.Failure.appChanged }
        await inserter.insert(text)
    }
}
