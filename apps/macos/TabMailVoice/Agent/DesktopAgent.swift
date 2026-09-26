// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// What agent mode can do with a spoken request. Each tool is one backend prompt; its bubble shows
/// beside the pill while agent mode listens, and its border circles while it runs.
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

/// Agent mode on the backend: one call chooses the tool for the spoken request
/// (`DictationConfig.agentPrompt`), a second has that tool write the text the app then inserts. The
/// instructions live in the backend prompts, shared by every desktop platform.
enum DesktopAgent {
    /// Why a request could not be carried out, as the overlay says it.
    enum Failure: LocalizedError, Equatable {
        /// The agent's reply named no tool it has.
        case noTool
        /// The agent chose a tool this Mac can't use (an app that isn't installed).
        case unavailable(AgentTool)
        /// The agent chose to edit, but no selected text could be read.
        case noSelection
        /// The tool wrote nothing.
        case noText
        case timedOut

        var errorDescription: String? {
            switch self {
            case .noTool: "Couldn't work out what to do. Try again."
            case .unavailable(.thunderbird): "Mail and calendar requests need Thunderbird with TabMail."
            case .unavailable(let tool): "\(tool.displayName) isn't available."
            case .noSelection: "Select the text to edit, then try again."
            case .noText: "Couldn't write that. Try again."
            case .timedOut: "That took too long. Try again."
            }
        }
    }

    /// The tool for `request`, asked under the account `userId`. Throws `unavailable` when the agent
    /// chooses a tool that isn't `offered`, and `noSelection` when it chooses to edit and nothing is
    /// selected.
    @MainActor
    static func chooseTool(
        for request: String, context: ScreenContext?, offered: [AgentTool], client: CompletionsClient, account: AccountModel, userId: String?,
        timeout: TimeInterval = DictationConfig.agentChooseTimeout
    ) async throws -> AgentTool {
        let reply = try await complete(chooseMessage(request: request, context: context), client: client, account: account, userId: userId, timeout: timeout)
        guard let tool = AgentTool(rawValue: reply) else {
            Log.error("DesktopAgent: reply named no tool (\(reply.count) chars)")
            throw Failure.noTool
        }
        guard offered.contains(tool) else { throw Failure.unavailable(tool) }
        if tool == .edit, selection(in: context).isEmpty { throw Failure.noSelection }
        return tool
    }

    /// The text `tool` writes for `request`, ready to insert (for Thunderbird, to send): for an edit,
    /// with the selection's own leading and trailing blank space, so replacing a whole line keeps its
    /// line break.
    @MainActor
    static func write(
        _ tool: AgentTool, for request: String, context: ScreenContext?, client: CompletionsClient, account: AccountModel, userId: String?,
        timeout: TimeInterval = DictationConfig.agentToolTimeout
    ) async throws -> String {
        let text = try await complete(toolMessage(tool, request: request, context: context), client: client, account: account, userId: userId, timeout: timeout)
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
        _ message: CompletionsMessage, client: CompletionsClient, account: AccountModel, userId: String?, timeout: TimeInterval
    ) async throws -> String {
        let clock = ContinuousClock()
        let started = clock.now
        do {
            let reply = try await withTimeout(seconds: timeout) { @MainActor in
                try await DictationController.withFreshToken(account: account, userId: userId) { try await client.complete(message, accessToken: $0) }
            }
            Log.debug("DesktopAgent: \(message.content) answered in \(clock.now - started) (\(reply.count) chars)")
            return reply.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch is TimeoutError {
            Log.error("DesktopAgent: \(message.content) timed out after \(clock.now - started)")
            throw Failure.timedOut
        }
    }
}
