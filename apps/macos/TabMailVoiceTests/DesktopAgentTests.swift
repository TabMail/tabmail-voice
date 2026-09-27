// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

/// The agent's two backend calls: what each sends, and how its reply becomes a tool or text to insert.
/// Never the network.
@MainActor
struct DesktopAgentTests {
    private let completions = StubTransport()
    private let request = "make this friendlier"

    private var client: CompletionsClient {
        CompletionsClient(baseURL: URL(string: "https://api.example.com")!, transport: completions.transport)
    }

    private func signedIn() -> AccountModel {
        AccountModel(client: AuthClient(transport: StubTransport().transport), store: InMemorySessionStore(Fixtures.session()))
    }

    private func screen(selected: String) -> ScreenContext {
        var context = ScreenContext(appName: "Example Notes", windowTitle: "Weekly sync", host: "notes.example.com", terminalProgram: "example-shell")
        context.textBeforeCaret = "Note: "
        context.selectedText = selected
        context.append(.heading, "Agenda")
        context.appendCaret()
        return context
    }

    private func reply(_ assistant: String) -> String {
        let json = String(decoding: try! JSONSerialization.data(withJSONObject: ["assistant": assistant]), as: UTF8.self)
        return Fixtures.completionsStream(final: json)
    }

    private func sentMessage(_ index: Int) -> [String: Any]? {
        guard completions.requests.indices.contains(index) else { return nil }
        return (Fixtures.jsonBody(of: completions.requests[index])["messages"] as? [[String: Any]])?.first
    }

    // MARK: Messages

    /// Every variable the backend prompt renders is sent, empty when unknown: the backend leaves a
    /// missing one in the prompt as written.
    @Test func withoutAScreenEveryVariableIsSentEmpty() {
        let choose = DesktopAgent.chooseMessage(request: request, context: nil)
        #expect(choose.content == "system_prompt_desktop_agent")
        #expect(choose.vars == ["app_name": "", "web_host": "", "window_title": "", "selected_text": "", "user_request": request])

        let edit = DesktopAgent.toolMessage(.edit, request: request, context: nil)
        #expect(edit.content == "system_prompt_desktop_edit")
        #expect(Set(edit.vars.keys) == ["app_name", "web_host", "window_title", "screen_text", "selected_text", "user_request"])

        let compose = DesktopAgent.toolMessage(.compose, request: request, context: nil)
        #expect(compose.content == "system_prompt_desktop_compose")
        #expect(Set(compose.vars.keys) == ["app_name", "web_host", "window_title", "screen_text", "selected_text", "user_request", "terminal_program"])

        let thunderbird = DesktopAgent.toolMessage(.thunderbird, request: request, context: nil)
        #expect(thunderbird.content == "system_prompt_desktop_thunderbird")
        #expect(Set(thunderbird.vars.keys) == ["app_name", "web_host", "window_title", "screen_text", "selected_text", "user_request"])
    }

    @Test func aToolIsSentTheScreenWithTheSelectionMarked() {
        let message = DesktopAgent.toolMessage(.compose, request: request, context: screen(selected: "Ship it Friday."))

        #expect(message.vars["app_name"] == "Example Notes")
        #expect(message.vars["web_host"] == "notes.example.com")
        #expect(message.vars["terminal_program"] == "example-shell")
        #expect(message.vars["selected_text"] == "Ship it Friday.")
        #expect(message.vars["screen_text"]?.contains("## Agenda") == true)
        #expect(message.vars["screen_text"]?.contains("» Note: ‸Ship it Friday.‸") == true)
    }

    /// A selection of only blank space is no text to edit.
    @Test func aBlankSelectionCountsAsNone() {
        #expect(DesktopAgent.selection(in: screen(selected: " \n")) == "")
        #expect(DesktopAgent.chooseMessage(request: request, context: screen(selected: "\n")).vars["selected_text"] == "")
    }

    // MARK: Fitting an edit to the selection

    @Test(arguments: [
        ("Ship it Friday.\n", "Could we ship Friday?", "Could we ship Friday?\n"),
        ("  indented line", "Rewritten line", "  Rewritten line"),
        ("plain", "\nRewritten\n", "Rewritten"),
        ("\n\nparagraph\n\n", "New paragraph", "\n\nNew paragraph\n\n"),
    ])
    func anEditKeepsTheSelectionsOwnSurroundingSpace(selection: String, edited: String, expected: String) {
        #expect(EditTool.fitted(edited, toSelection: selection) == expected)
    }

    // MARK: Choosing and writing

    /// Edit and Compose are never offered together: text selected is Edit, nothing (or only blank
    /// space, or no screen read) is Compose; Thunderbird joins them when an email app is available.
    @Test func theSelectionDecidesTheWritingTool() {
        #expect(DesktopAgent.writingTool(for: screen(selected: "Ship it.")) == .edit)
        #expect(DesktopAgent.writingTool(for: screen(selected: "")) == .compose)
        #expect(DesktopAgent.writingTool(for: screen(selected: " \n")) == .compose)
        #expect(DesktopAgent.writingTool(for: nil) == .compose)
        #expect(DesktopAgent.tools(for: screen(selected: "Ship it."), emailAppAvailable: false) == [.edit])
        #expect(DesktopAgent.tools(for: screen(selected: "Ship it."), emailAppAvailable: true) == [.edit, .thunderbird])
        #expect(DesktopAgent.tools(for: nil, emailAppAvailable: true) == [.compose, .thunderbird])
    }

    /// Without an email app there is nothing to choose between: no agent call.
    @Test func withoutAnEmailAppTheWritingToolIsUsedUnasked() async throws {
        let tool = try await DesktopAgent.tool(for: request, context: screen(selected: "Ship it."), emailAppAvailable: false, client: client, account: signedIn(), userId: Fixtures.userId)

        #expect(tool == .edit)
        #expect(completions.requests.isEmpty)
    }

    /// With an email app, the agent decides only whether the request goes there; its pick of a
    /// writing tool gives way to the selection's.
    @Test(arguments: [
        ("thunderbird", "Ship it.", AgentTool.thunderbird),
        ("edit", "Ship it.", AgentTool.edit),
        ("compose", "Ship it.", AgentTool.edit),
        ("edit", "", AgentTool.compose),
        ("compose", "", AgentTool.compose),
    ])
    func theAgentDecidesOnlyWhetherTheEmailAppGetsTheRequest(reply: String, selected: String, tool: AgentTool) async throws {
        completions.enqueue(status: 200, text: self.reply(reply))

        let chosen = try await DesktopAgent.tool(for: request, context: screen(selected: selected), emailAppAvailable: true, client: client, account: signedIn(), userId: Fixtures.userId)

        #expect(chosen == tool)
        #expect(completions.requests.count == 1)
        #expect(sentMessage(0)?["content"] as? String == "system_prompt_desktop_agent")
        #expect(sentMessage(0)?["user_request"] as? String == request)
        #expect(sentMessage(0)?["selected_text"] as? String == selected)
    }

    /// The backend returns nothing when the reply named no tool it has.
    @Test(arguments: ["", "rewrite"])
    func aReplyNamingNoToolFails(reply: String) async {
        completions.enqueue(status: 200, text: self.reply(reply))

        await #expect(throws: DesktopAgent.Failure.noTool) {
            try await DesktopAgent.tool(for: request, context: screen(selected: "Ship it."), emailAppAvailable: true, client: client, account: signedIn(), userId: Fixtures.userId)
        }
    }

    /// The Thunderbird tool's message is sent to TabMail's chat as it comes: no fitting to a selection.
    @Test func theThunderbirdToolWritesAChatMessage() async throws {
        completions.enqueue(status: 200, text: reply("  Find the invoice Sam sent last week.\n"))

        let message = try await DesktopAgent.write(.thunderbird, for: "find sam's invoice", context: screen(selected: " Sam \n"), client: client, account: signedIn(), userId: Fixtures.userId)

        #expect(message == "Find the invoice Sam sent last week.")
        #expect(sentMessage(0)?["content"] as? String == "system_prompt_desktop_thunderbird")
    }

    @Test func aToolThatWritesNothingFails() async {
        completions.enqueue(status: 200, text: reply("  "))

        await #expect(throws: DesktopAgent.Failure.noText) {
            try await DesktopAgent.write(.compose, for: request, context: nil, client: client, account: signedIn(), userId: Fixtures.userId)
        }
    }

    @Test func aBackendErrorIsReportedAsItself() async {
        completions.enqueue(status: 402, json: ["error": "no_active_subscription"])

        await #expect(throws: BackendError.subscriptionRequired) {
            try await DesktopAgent.write(.edit, for: request, context: screen(selected: "Ship it."), client: client, account: signedIn(), userId: Fixtures.userId)
        }
    }
}
