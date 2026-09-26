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
        #expect(DesktopAgent.fitted(edited, toSelection: selection) == expected)
    }

    // MARK: Choosing and writing

    @Test(arguments: [("edit", AgentTool.edit), ("compose", AgentTool.compose)])
    func choosesTheToolTheAgentNames(reply: String, tool: AgentTool) async throws {
        completions.enqueue(status: 200, text: self.reply(reply))

        let chosen = try await DesktopAgent.chooseTool(for: request, context: screen(selected: "Ship it."), client: client, account: signedIn(), userId: Fixtures.userId)

        #expect(chosen == tool)
        #expect(sentMessage(0)?["content"] as? String == "system_prompt_desktop_agent")
        #expect(sentMessage(0)?["user_request"] as? String == request)
        #expect(sentMessage(0)?["selected_text"] as? String == "Ship it.")
    }

    /// The backend returns nothing when the reply named no tool it has.
    @Test(arguments: ["", "rewrite"])
    func aReplyNamingNoToolFails(reply: String) async {
        completions.enqueue(status: 200, text: self.reply(reply))

        await #expect(throws: DesktopAgent.Failure.noTool) {
            try await DesktopAgent.chooseTool(for: request, context: screen(selected: "Ship it."), client: client, account: signedIn(), userId: Fixtures.userId)
        }
    }

    @Test func choosingToEditWithNothingSelectedFails() async {
        completions.enqueue(status: 200, text: reply("edit"))

        await #expect(throws: DesktopAgent.Failure.noSelection) {
            try await DesktopAgent.chooseTool(for: request, context: screen(selected: ""), client: client, account: signedIn(), userId: Fixtures.userId)
        }
    }

    @Test func aToolThatWritesNothingFails() async {
        completions.enqueue(status: 200, text: reply("  "))

        await #expect(throws: DesktopAgent.Failure.noText) {
            try await DesktopAgent.write(.compose, for: request, context: nil, client: client, account: signedIn(), userId: Fixtures.userId)
        }
    }

    @Test func anAgentThatNeverAnswersTimesOut() async {
        completions.enqueue(status: 200, text: reply("edit"))
        completions.gate = { try? await Task.sleep(for: .seconds(60)) }
        let started = ContinuousClock.now

        await #expect(throws: DesktopAgent.Failure.timedOut) {
            try await DesktopAgent.chooseTool(for: request, context: nil, client: client, account: signedIn(), userId: Fixtures.userId, timeout: 0.2)
        }
        #expect(ContinuousClock.now - started < .seconds(5))
    }

    @Test func aBackendErrorIsReportedAsItself() async {
        completions.enqueue(status: 402, json: ["error": "no_active_subscription"])

        await #expect(throws: BackendError.subscriptionRequired) {
            try await DesktopAgent.write(.edit, for: request, context: screen(selected: "Ship it."), client: client, account: signedIn(), userId: Fixtures.userId)
        }
    }
}
