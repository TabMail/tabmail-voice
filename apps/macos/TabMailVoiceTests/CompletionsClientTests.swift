// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

struct CompletionsClientTests {
    private let baseURL = URL(string: "https://api.example.com")!
    private let message = CompletionsMessage(role: "system", content: "system_prompt_example", vars: ["dictation": "hello world", "app_name": "Example"])

    @Test func sendsTheNamedPromptWithItsVariables() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Hello, world.","thinking":"","token_usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}"#))
        let client = CompletionsClient(baseURL: baseURL, clientVersion: "test-version", transport: stub.transport)

        let earliestTimestamp = Int(Date().timeIntervalSince1970 * 1000)
        let reply = try await client.complete(message, accessToken: "token-abc")
        let latestTimestamp = Int(Date().timeIntervalSince1970 * 1000)

        #expect(reply == "Hello, world.")
        let request = try #require(stub.requests.first)
        #expect(request.url?.absoluteString == "https://api.example.com/completions/chat")
        #expect(request.httpMethod == "POST")
        #expect(request.timeoutInterval == DictationConfig.completionsRequestTimeout)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-abc")
        #expect(request.value(forHTTPHeaderField: "X-Client-Type") == "macos")
        #expect(request.value(forHTTPHeaderField: "X-Client-Version") == "test-version")
        let body = Fixtures.jsonBody(of: request)
        #expect(body["disable_tools"] as? Bool == true)
        #expect(body["client_timezone"] as? String == TimeZone.current.identifier)
        let timestamp = try #require(body["client_timestamp_ms"] as? Int)
        #expect(timestamp >= earliestTimestamp)
        #expect(timestamp <= latestTimestamp)
        let messages = try #require(body["messages"] as? [[String: Any]])
        #expect(messages.count == 1)
        guard messages.count == 1 else { return }
        // Variables sit beside role and content, not nested: the backend reads them from there.
        #expect(messages[0] as NSDictionary == ["role": "system", "content": "system_prompt_example", "dictation": "hello world", "app_name": "Example"] as NSDictionary)
    }

    /// The default client identifies the running app's version, not a fixed fallback version.
    @Test func sendsTheRunningAppVersionByDefault() async throws {
        let version = try #require(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Hello."}"#))
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)

        _ = try await client.complete(message, accessToken: "t")

        let request = try #require(stub.requests.first)
        #expect(request.value(forHTTPHeaderField: "X-Client-Version") == version)
    }

    /// A later keepalive must not hide an earlier stream error.
    @Test func aStreamErrorFails() async {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: ": primer\n\nevent: keepalive\ndata: {}\n\nevent: error\ndata: {\"error\":\"internal_error\"}\n\nevent: keepalive\ndata: {}\n\n")
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: BackendError.failed(status: 200)) {
            _ = try await client.complete(message, accessToken: "t")
        }
    }

    /// The backend reports a refused request (e.g. a prompt this client can't use) in `final`.
    @Test func aFinalCarryingAnErrorFails() async {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"error":"Requested prompt is not available for this client platform."}"#))
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
        (403, "consent_required", .accountSetupRequired),
        (403, "access_denied", .accessDenied),
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

    /// A proxy's plain-text error, or a JSON body without a code, still reports the HTTP failure.
    @Test(arguments: [
        (502, "upstream unavailable", BackendError.failed(status: 502)),
        (403, "{}", .accessDenied),
    ])
    func anHTTPErrorWithoutAnErrorCodeKeepsItsStatus(status: Int, body: String, expected: BackendError) async {
        let stub = StubTransport()
        stub.enqueue(status: status, text: body)
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: expected) {
            _ = try await client.complete(message, accessToken: "t")
        }
    }

    /// Selecting a result must filter by event name and use the last final payload.
    @Test func usesTheLastFinalEvenWhenOtherEventsFollow() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Earlier."}"#)
            + "event: final\ndata: {\"assistant\":\"Latest.\"}\n\nevent: keepalive\ndata: {}\n\n")
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)

        #expect(try await client.complete(message, accessToken: "t") == "Latest.")
    }

    /// A final event exists, but malformed JSON, a wrong field type or a missing reply cannot succeed.
    @Test(arguments: [
        ("{", BackendError.invalidResponse),
        (#"{"assistant":42}"#, .invalidResponse),
        ("{}", .failed(status: 200)),
    ])
    func aFinalWithoutAUsableReplyFails(payload: String, expected: BackendError) async {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Fixtures.completionsStream(final: payload))
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: expected) {
            _ = try await client.complete(message, accessToken: "t")
        }
    }

    /// The backend's `JSON.stringify` leaves these unescaped; they are part of the reply, not line ends.
    @Test(arguments: ["\u{85}", "\u{2028}", "\u{2029}"])
    func keepsUnicodeLineSeparatorsInTheReply(separator: String) async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Alpha"# + separator + #"beta"}"#))
        let client = CompletionsClient(baseURL: baseURL, transport: stub.transport)

        #expect(try await client.complete(message, accessToken: "t") == "Alpha\(separator)beta")
    }

    // MARK: Server-sent events

    @Test func eventsEndAtBlankLinesAndSkipComments() {
        let events = CompletionsClient.events(inSSE: ": primer\n\nevent: keepalive\n: comment inside the event\ndata: {}\n\ndata: outside an event\n\nevent: final\ndata: {\"a\":1}\n\n")
        #expect(events == [SSEEvent(name: "keepalive", data: "{}"), SSEEvent(name: "final", data: "{\"a\":1}")])
    }

    /// Consecutive events without a blank line between them, and a last event without a trailing one.
    @Test func eventsAlsoEndAtTheNextEventAndAtTheEnd() {
        let events = CompletionsClient.events(inSSE: "event: \tkeepalive\t\ndata: first\nevent: final\ndata: last")
        #expect(events == [SSEEvent(name: "keepalive", data: "first"), SSEEvent(name: "final", data: "last")])
    }

    @Test(arguments: ["\n", "\r\n", "\r"])
    func eventsJoinDataLinesAtEveryLineEnd(lineEnd: String) {
        let body = ["event: final", "data: first", "data: second\u{2028}third", "", ""].joined(separator: lineEnd)
        let events = CompletionsClient.events(inSSE: body)
        #expect(events == [SSEEvent(name: "final", data: "first\nsecond\u{2028}third")])
    }
}
