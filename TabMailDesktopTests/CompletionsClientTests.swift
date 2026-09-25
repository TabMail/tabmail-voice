// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMail

struct CompletionsClientTests {
    private let baseURL = URL(string: "https://api.example.com")!
    private let message = CompletionsMessage(role: "system", content: "system_prompt_example", vars: ["dictation": "hello world", "app_name": "Example"])

    /// What the backend streams: a comment primer, keepalives while the model works, then `final`.
    private static func stream(final: String) -> String {
        ": \(String(repeating: " ", count: 20))\n\nevent: keepalive\ndata: {}\n\nevent: keepalive\ndata: {}\n\nevent: final\ndata: \(final)\n\n"
    }

    @Test func sendsTheNamedPromptWithItsVariables() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Self.stream(final: #"{"assistant":"Hello, world.","thinking":"","token_usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}"#))
        let client = CompletionsClient(baseURL: baseURL, clientVersion: "0.1.0", transport: stub.transport)

        let reply = try await client.complete(message, accessToken: "token-abc")

        #expect(reply == "Hello, world.")
        let request = try #require(stub.requests.first)
        #expect(request.url?.absoluteString == "https://api.example.com/completions/chat")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-abc")
        #expect(request.value(forHTTPHeaderField: "X-Client-Type") == "macos")
        #expect(request.value(forHTTPHeaderField: "X-Client-Version") == "0.1.0")
        let body = Fixtures.jsonBody(of: request)
        #expect(body["disable_tools"] as? Bool == true)
        #expect(body["client_timezone"] as? String == TimeZone.current.identifier)
        #expect(body["client_timestamp_ms"] is Int)
        let messages = try #require(body["messages"] as? [[String: Any]])
        #expect(messages.count == 1)
        guard messages.count == 1 else { return }
        // Variables sit beside role and content, not nested: the backend reads them from there.
        #expect(messages[0] as NSDictionary == ["role": "system", "content": "system_prompt_example", "dictation": "hello world", "app_name": "Example"] as NSDictionary)
    }

    @Test func aStreamErrorFails() async {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: ": primer\n\nevent: keepalive\ndata: {}\n\nevent: error\ndata: {\"error\":\"internal_error\"}\n\n")
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: BackendError.failed(status: 200)) {
            _ = try await client.complete(message, accessToken: "t")
        }
    }

    /// The backend reports a refused request (e.g. a prompt this client can't use) in `final`.
    @Test func aFinalCarryingAnErrorFails() async {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Self.stream(final: #"{"error":"Requested prompt is not available for this client platform."}"#))
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: BackendError.failed(status: 200)) {
            _ = try await client.complete(message, accessToken: "t")
        }
    }

    @Test func aStreamWithoutFinalIsInvalid() async {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: ": primer\n\nevent: keepalive\ndata: {}\n\n")
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: BackendError.invalidResponse) {
            _ = try await client.complete(message, accessToken: "t")
        }
    }

    @Test(arguments: [
        (401, "invalid_token", BackendError.unauthorized),
        (402, "no_active_subscription", .subscriptionRequired),
        (429, "rate_limited", .rateLimited),
        (500, "internal_error", .failed(status: 500)),
    ])
    func mapsHTTPErrors(status: Int, code: String, expected: BackendError) async {
        let stub = StubTransport()
        stub.enqueue(status: status, json: ["error": code])
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: expected) {
            _ = try await client.complete(message, accessToken: "t")
        }
    }

    // MARK: Server-sent events

    @Test func eventsEndAtBlankLinesAndSkipComments() {
        let events = CompletionsClient.events(inSSE: ": primer\n\nevent: keepalive\ndata: {}\n\nevent: final\ndata: {\"a\":1}\n\n")
        #expect(events == [SSEEvent(name: "keepalive", data: "{}"), SSEEvent(name: "final", data: "{\"a\":1}")])
    }

    /// Consecutive events without a blank line between them, and a last event without a trailing one.
    @Test func eventsAlsoEndAtTheNextEventAndAtTheEnd() {
        let events = CompletionsClient.events(inSSE: "event: keepalive\ndata: {}\nevent: final\ndata: {}")
        #expect(events.map(\.name) == ["keepalive", "final"])
    }

    @Test func eventsJoinDataLinesAndAcceptCRLF() {
        let events = CompletionsClient.events(inSSE: "event: final\r\ndata: first\r\ndata: second\r\n\r\n")
        #expect(events == [SSEEvent(name: "final", data: "first\nsecond")])
    }
}
