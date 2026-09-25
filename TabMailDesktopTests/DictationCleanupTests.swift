// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMail

struct DictationCleanupTests {
    @Test func sendsTheDictationWithWhereItGoesAndWhatIsOnScreen() {
        var context = ScreenContext(appName: "Example Notes", bundleID: "com.example.notes")
        context.host = "notes.example.com"
        context.terminalProgram = "example-shell"
        context.windowTitle = "Weekly sync"
        context.textBeforeCaret = "Ask Jordan about the "
        context.append(.heading, "Agenda")
        context.appendCaret()

        let message = DictationCleanup.message(dictation: "quarterly road map", context: context)

        #expect(message.role == "system")
        #expect(message.content == DictationConfig.cleanupPrompt)
        #expect(message.vars == [
            "dictation": "quarterly road map",
            "app_name": "Example Notes",
            "web_host": "notes.example.com",
            "terminal_program": "example-shell",
            "window_title": "Weekly sync",
            "screen_text": "## Agenda\n» Ask Jordan about the ‸",
        ])
    }

    /// Without Accessibility access there is no context: the prompt still gets every field, empty.
    @Test func withoutContextEveryFieldIsEmpty() {
        let message = DictationCleanup.message(dictation: "hello", context: nil)
        #expect(message.vars == [
            "dictation": "hello", "app_name": "", "web_host": "", "terminal_program": "", "window_title": "", "screen_text": "",
        ])
    }
}

/// What gets pasted: the cleaned-up text, or the transcript as heard whenever the cleanup fails.
@MainActor
struct DictationCleanupFallbackTests {
    private let transcript = "ask jordan about the road map"
    private let backend = StubTransport()

    private func cleanUp(signedIn: Bool = true) async -> String {
        let account = AccountModel(
            client: AuthClient(transport: StubTransport().transport),
            store: signedIn ? InMemorySessionStore(Fixtures.session()) : InMemorySessionStore()
        )
        let client = CompletionsClient(baseURL: URL(string: "https://api.example.com")!, transport: backend.transport)
        return await DictationCleanup.cleanUp(transcript, context: nil, client: client, account: account)
    }

    @Test func pastesTheCleanedUpText() async {
        backend.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":" Ask Jordan about the roadmap.\n"}"#))

        #expect(await cleanUp() == "Ask Jordan about the roadmap.")
        #expect(backend.requests.count == 1)
        guard backend.requests.count == 1 else { return }
        let messages = Fixtures.jsonBody(of: backend.requests[0])["messages"] as? [[String: Any]]
        #expect(messages?.first?["dictation"] as? String == transcript)
    }

    @Test(arguments: [
        (500, #"{"error":"internal_error"}"#),
        (402, #"{"error":"no_active_subscription"}"#),
        (429, #"{"error":"rate_limited"}"#),
        (200, ": primer\n\nevent: keepalive\ndata: {}\n\nevent: error\ndata: {\"error\":\"internal_error\"}\n\n"),
        (200, Fixtures.completionsStream(final: #"{"error":"Requested prompt is not available for this client platform."}"#)),
        (200, Fixtures.completionsStream(final: #"{"assistant":" \n"}"#)),
        (200, ": primer\n\nevent: keepalive\ndata: {}\n\n"),
    ])
    func aFailedCleanupPastesTheTranscriptAsHeard(status: Int, body: String) async {
        backend.enqueue(status: status, text: body)

        #expect(await cleanUp() == transcript)
        #expect(backend.requests.count == 1)
    }

    @Test func anUnreachableBackendPastesTheTranscriptAsHeard() async {
        // Nothing queued: the transport throws, as it does offline.
        #expect(await cleanUp() == transcript)
        #expect(backend.requests.count == 1)
    }

    @Test func signedOutPastesTheTranscriptWithoutCallingTheBackend() async {
        #expect(await cleanUp(signedIn: false) == transcript)
        #expect(backend.requests.isEmpty)
    }
}
