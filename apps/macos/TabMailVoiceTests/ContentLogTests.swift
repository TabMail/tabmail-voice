// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
import Testing
@testable import TabMailVoice

/// The debug log file's content entries (ADR-DESK-015): requests to the backend and their replies
/// in full, never an access token or audio.
struct ContentLogTests {
    private let baseURL = URL(string: "https://api.example.com")!

    /// The `Log.content` entries logged while `body` runs.
    private final class Entries: Sendable {
        private let state = OSAllocatedUnfairLock<[(label: String, text: String)]>(initialState: [])
        var all: [(label: String, text: String)] { state.withLock { $0 } }
        var joined: String { all.map { "\($0.label)\n\($0.text)" }.joined(separator: "\n") }
        func add(_ label: String, _ text: String) { state.withLock { $0.append((label, text)) } }
    }

    private func logged(_ body: () async throws -> Void) async rethrows -> Entries {
        let entries = Entries()
        try await Log.$contentObserver.withValue({ entries.add($0, $1) }) { try await body() }
        return entries
    }

    @Test func aCompletionsCallLogsItsRequestVariablesAndRawReplyButNotTheToken() async throws {
        let screen = "## Inbox\n» Dear Alex,‸\n" + String(repeating: "long screen line\n", count: 2_000)
        let message = CompletionsMessage(role: "system", content: "system_prompt_example", vars: ["screen_text": screen, "user_request": "reply to Alex"])
        let stream = Fixtures.completionsStream(final: #"{"assistant":"Composed reply.","thinking":""}"#)
        let stub = StubTransport()
        stub.enqueue(status: 200, text: stream)
        let client = CompletionsClient(baseURL: baseURL, clientVersion: "1.0", transport: stub.transport)

        let entries = try await logged { _ = try await client.complete(message, accessToken: "secret-token-123") }

        #expect(entries.all.map(\.label) == [
            "Completions system_prompt_example request",
            "Completions system_prompt_example variables",
            "Completions system_prompt_example response",
        ])
        guard entries.all.count == 3 else { return }
        let request = entries.all[0].text
        #expect(request.hasPrefix("POST https://api.example.com/completions/chat\n"))
        #expect(request.contains("Authorization: \(BackendLog.maskedAuthorization)"))
        #expect(request.contains("X-Client-Type: macos"))
        // The body exactly as sent.
        let sent = try #require(stub.requests.first?.httpBody)
        #expect(request.hasSuffix("\n\n" + String(decoding: sent, as: UTF8.self)))
        // Every variable whole, its line breaks as they are.
        #expect(entries.all[1].text.contains("--- screen_text (\(screen.count) chars) ---\n\(screen)"))
        #expect(entries.all[1].text.contains("--- user_request (13 chars) ---\nreply to Alex"))
        #expect(entries.all[2].text.hasPrefix("HTTP 200\n"))
        #expect(entries.all[2].text.hasSuffix("\n\n" + stream))
        #expect(!entries.joined.contains("secret-token-123"))
    }

    @Test func aFailedCompletionsCallStillLogsTheReply() async {
        let stub = StubTransport()
        stub.enqueue(status: 502, json: ["error": "upstream_failed"])
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)

        let entries = await logged {
            _ = try? await client.complete(CompletionsMessage(role: "system", content: "p", vars: [:]), accessToken: "t")
        }

        #expect(entries.all.last?.label == "Completions p response")
        #expect(entries.all.last?.text.hasPrefix("HTTP 502\n") == true)
        #expect(entries.all.last?.text.hasSuffix(#"{"error":"upstream_failed"}"#) == true)
    }

    @Test func aTranscriptionLogsTheReplyButNeitherTheAudioNorTheToken() async throws {
        let wav = Data("RIFF-test-audio-that-must-not-be-logged".utf8)
        let stub = StubTransport()
        stub.enqueue(status: 200, json: ["text": "Hello there."])
        let client = TranscriptionClient(baseURL: baseURL, transport: stub.transport)

        let entries = try await logged { _ = try await client.transcribe(wav: wav, accessToken: "secret-token-123") }

        #expect(entries.all.map(\.label) == ["Transcription request", "Transcription response"])
        guard entries.all.count == 2 else { return }
        #expect(entries.all[0].text.hasPrefix("POST https://api.example.com/dictation/transcribe\n"))
        #expect(entries.all[0].text.contains("<\(wav.count) bytes of WAV, not logged>"))
        #expect(entries.all[0].text.contains(#""format":"wav""#))
        #expect(entries.all[1].text.contains(#""text":"Hello there.""#))
        // The stub did receive the audio: the log left it out.
        let sent = try #require(stub.requests.first?.httpBody)
        #expect(String(decoding: sent, as: UTF8.self).contains(wav.base64EncodedString()))
        #expect(!entries.joined.contains(wav.base64EncodedString()))
        #expect(!entries.joined.contains("secret-token-123"))
    }

    @Test func theAuthorizationHeaderIsMaskedWhateverItsCase() {
        var request = URLRequest(url: baseURL)
        request.httpMethod = "POST"
        request.setValue("Bearer secret-token-123", forHTTPHeaderField: "authorization")
        request.setValue("macos", forHTTPHeaderField: "X-Client-Type")

        let text = BackendLog.request(request, body: "{}")

        #expect(!text.contains("secret-token-123"))
        #expect(text.contains(BackendLog.maskedAuthorization))
        #expect(text.contains("X-Client-Type: macos"))
        #expect(text.hasSuffix("\n\n{}"))
    }

    @Test func aResponseLogCarriesItsHeadersAndWholeBody() throws {
        let response = try #require(HTTPURLResponse(url: baseURL, statusCode: 200, httpVersion: nil, headerFields: ["cf-ray": "abc123-SJC"]))
        let body = String(repeating: "x", count: 50_000)

        let text = BackendLog.response(response, data: Data(body.utf8))

        #expect(text.hasPrefix("HTTP 200\n"))
        #expect(text.contains("cf-ray: abc123-SJC"))
        #expect(text.hasSuffix("\n\n" + body))
    }

    @Test func aBlockKeepsItsTextWholeBetweenNamedLines() {
        #expect(LogFile.block("Transcript", "line one\nline two") == "Transcript (17 chars) >>>\nline one\nline two\n<<< Transcript")
    }

    @Test func aScreenReadLogsEveryField() {
        var context = ScreenContext(appName: "Example", bundleID: "com.example.app")
        context.windowTitle = "Inbox"
        context.host = "mail.example.com"
        context.focusedRole = "AXTextArea"
        context.textBeforeCaret = "Dear Alex,"
        context.selectedText = "draft"
        context.textAfterCaret = "Thanks"
        context.stoppedEarly = "time budget"
        context.append(.heading, "Inbox")
        context.appendCaret()

        let text = context.logDescription

        #expect(text.hasPrefix("app Example (com.example.app), window title Inbox, host mail.example.com, terminal program -, focused AXTextArea, stopped: time budget\n"))
        #expect(text.contains("--- text before the caret ---\nDear Alex,\n"))
        #expect(text.contains("--- selected text ---\ndraft\n"))
        #expect(text.contains("--- text after the caret ---\nThanks\n"))
        #expect(text.hasSuffix("--- visible text ---\n" + context.renderedText()))
    }
}
