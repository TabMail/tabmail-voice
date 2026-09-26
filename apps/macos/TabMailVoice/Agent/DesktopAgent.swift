// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// What agent mode can do with a spoken request. Each tool is one backend prompt; its bubble shows
/// above the pill while agent mode listens, and its border circles while it runs. Edit and Compose
/// are never offered together: the selection decides which (`DesktopAgent.writingTool(for:)`).
enum AgentTool: String, CaseIterable, Sendable {
    /// Rewrites the selected text in place, as asked.
    case edit
    /// Writes new text at the caret, as asked.
    case compose
    /// Sends a mail or calendar request to TabMail's chat in Thunderbird (`ThunderbirdRelay`).
    case thunderbird

    var displayName: String {
        switch self {
        case .edit: "Edit"
        case .compose: "Compose"
        case .thunderbird: "Thunderbird"
        }
    }

    /// SF Symbol shown in the tool's bubble, unless it shows the app's icon (Thunderbird's).
    var symbolName: String {
        switch self {
        case .edit: "pencil"
        case .compose: "square.and.pencil"
        case .thunderbird: "envelope"
        }
    }

    var prompt: String {
        switch self {
        case .edit: DictationConfig.agentEditPrompt
        case .compose: DictationConfig.agentComposePrompt
        case .thunderbird: DictationConfig.agentThunderbirdPrompt
        }
    }
}

/// Agent mode on the backend: the tool for the spoken request is chosen (`tool(for:…)`), then has the
/// backend write the text the app inserts, or sends to Thunderbird. The instructions live in the
/// backend prompts, shared by every desktop platform. No call has a deadline of its own: the request
/// takes as long as the model does (owner, 2026-09-26: agent mode has no timeout).
enum DesktopAgent {
    /// Why a request could not be carried out, as the overlay says it.
    enum Failure: LocalizedError, Equatable {
        /// The agent's reply named no tool it has.
        case noTool
        /// The tool wrote nothing.
        case noText

        var errorDescription: String? {
            switch self {
            case .noTool: "Couldn't work out what to do. Try again."
            case .noText: "Couldn't write that. Try again."
            }
        }
    }

    /// The tools agent mode offers for the screen read at key-down: Edit when text is selected,
    /// Compose when not, and Thunderbird when an email app is set up for it.
    static func tools(for context: ScreenContext?, emailAppAvailable: Bool) -> [AgentTool] {
        [writingTool(for: context)] + (emailAppAvailable ? [.thunderbird] : [])
    }

    /// Edit when text is selected, Compose when not.
    static func writingTool(for context: ScreenContext?) -> AgentTool {
        selection(in: context).isEmpty ? .compose : .edit
    }

    /// The tool for `request`: the writing tool (`writingTool(for:)`), unless an email app is available
    /// and the agent, asked under the account `userId`, sends the request there.
    @MainActor
    static func tool(
        for request: String, context: ScreenContext?, emailAppAvailable: Bool, client: CompletionsClient, account: AccountModel, userId: String?
    ) async throws -> AgentTool {
        let writing = writingTool(for: context)
        guard emailAppAvailable else { return writing }
        let reply = try await complete(chooseMessage(request: request, context: context), client: client, account: account, userId: userId)
        guard let chosen = AgentTool(rawValue: reply) else {
            Log.error("DesktopAgent: reply named no tool (\(reply.count) chars)")
            throw Failure.noTool
        }
        return chosen == .thunderbird ? .thunderbird : writing
    }

    /// The text `tool` writes for `request`, ready to insert (for Thunderbird, to send): for an edit,
    /// with the selection's own leading and trailing blank space, so replacing a whole line keeps its
    /// line break.
    @MainActor
    static func write(
        _ tool: AgentTool, for request: String, context: ScreenContext?, client: CompletionsClient, account: AccountModel, userId: String?
    ) async throws -> String {
        let text = try await complete(toolMessage(tool, request: request, context: context), client: client, account: account, userId: userId)
        guard !text.isEmpty else { throw Failure.noText }
        switch tool {
        case .edit: return fitted(text, toSelection: selection(in: context))
        case .compose, .thunderbird: return text
        }
    }

    /// The selected text read at key-down; empty when nothing is selected or it could not be read.
    static func selection(in context: ScreenContext?) -> String {
        guard let selected = context?.selectedText,
              !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return "" }
        return selected
    }

    /// `text` with the leading and trailing blank space of `selection` in place of its own.
    static func fitted(_ text: String, toSelection selection: String) -> String {
        let leading = selection.prefix(while: \.isWhitespace)
        let trailing = selection.reversed().prefix(while: \.isWhitespace).reversed()
        return leading + text.trimmingCharacters(in: .whitespacesAndNewlines) + String(trailing)
    }

    /// The agent's prompt and its variables. Every variable is sent, empty when unknown: the backend
    /// leaves a missing one in the prompt as written.
    static func chooseMessage(request: String, context: ScreenContext?) -> CompletionsMessage {
        CompletionsMessage(role: "system", content: DictationConfig.agentPrompt, vars: [
            "app_name": context?.appName ?? "",
            "web_host": context?.host ?? "",
            "window_title": context?.windowTitle ?? "",
            "selected_text": selection(in: context),
            "user_request": request,
        ])
    }

    /// A tool's prompt and its variables.
    static func toolMessage(_ tool: AgentTool, request: String, context: ScreenContext?) -> CompletionsMessage {
        var vars = [
            "app_name": context?.appName ?? "",
            "web_host": context?.host ?? "",
            "window_title": context?.windowTitle ?? "",
            "screen_text": context?.renderedText() ?? "",
            "selected_text": selection(in: context),
            "user_request": request,
        ]
        if tool == .compose { vars["terminal_program"] = context?.terminalProgram ?? "" }
        return CompletionsMessage(role: "system", content: tool.prompt, vars: vars)
    }

    @MainActor
    private static func complete(
        _ message: CompletionsMessage, client: CompletionsClient, account: AccountModel, userId: String?
    ) async throws -> String {
        let clock = ContinuousClock()
        let started = clock.now
        let reply = try await DictationController.withFreshToken(account: account, userId: userId) { try await client.complete(message, accessToken: $0) }
        Log.debug("DesktopAgent: \(message.content) answered in \(clock.now - started) (\(reply.count) chars)")
        return reply.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
