// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// A message naming a backend prompt: `content` is the prompt's name and `vars` its template
/// variables, flattened into top-level JSON keys beside `role` and `content` (as on iOS).
struct CompletionsMessage: Encodable, Sendable, Equatable {
    let role: String
    let content: String
    let vars: [String: String]

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        try container.encode(role, forKey: DynamicCodingKey("role"))
        try container.encode(content, forKey: DynamicCodingKey("content"))
        for (key, value) in vars {
            try container.encode(value, forKey: DynamicCodingKey(key))
        }
    }
}

struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

struct CompletionsRequest: Encodable, Sendable {
    let messages: [CompletionsMessage]
    let client_timestamp_ms: Int
    let client_timezone: String
    let disable_tools: Bool
}

/// The payload of the stream's `final` event.
struct CompletionsResponse: Decodable, Sendable {
    let assistant: String?
    let error: String?
}

/// One server-sent event.
struct SSEEvent: Equatable {
    var name: String
    var data: String
}

/// Calls the TabMail backend's `POST /completions/chat` with one named prompt and returns the
/// model's reply. The backend answers with server-sent events (keepalives while the model works,
/// then `final`, or `error`); the whole stream is read, then parsed.
struct CompletionsClient: Sendable {
    let baseURL: URL
    let clientVersion: String
    let transport: HTTPTransport

    init(
        baseURL: URL,
        clientVersion: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
        transport: @escaping HTTPTransport = HTTP.live
    ) {
        self.baseURL = baseURL
        self.clientVersion = clientVersion
        self.transport = transport
    }

    func complete(_ message: CompletionsMessage, accessToken: String) async throws -> String {
        var request = URLRequest(url: baseURL.appending(path: DictationConfig.completionsPath))
        request.httpMethod = "POST"
        request.timeoutInterval = DictationConfig.completionsRequestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(DictationConfig.clientType, forHTTPHeaderField: "X-Client-Type")
        request.setValue(clientVersion, forHTTPHeaderField: "X-Client-Version")
        request.httpBody = try JSONEncoder().encode(CompletionsRequest(
            messages: [message],
            client_timestamp_ms: Int(Date().timeIntervalSince1970 * 1000),
            client_timezone: TimeZone.current.identifier,
            disable_tools: true
        ))

        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
        guard http.statusCode == 200 else {
            throw BackendError(status: http.statusCode, code: (try? JSONDecoder().decode(BackendError.Body.self, from: data))?.error)
        }
        let events = Self.events(inSSE: String(decoding: data, as: UTF8.self))
        guard !events.contains(where: { $0.name == "error" }) else { throw BackendError.failed(status: http.statusCode) }
        guard let final = events.last(where: { $0.name == "final" }),
              let reply = try? JSONDecoder().decode(CompletionsResponse.self, from: Data(final.data.utf8))
        else { throw BackendError.invalidResponse }
        guard reply.error == nil, let assistant = reply.assistant else { throw BackendError.failed(status: http.statusCode) }
        return assistant
    }

    /// Splits a server-sent-events body into events, as iOS `BackendClient.parseSSELines` does: an
    /// event ends at a blank line, at the next `event:` line or at the end of the body, and `:`
    /// lines (the backend's buffer primer) are comments.
    static func events(inSSE body: String) -> [SSEEvent] {
        var events: [SSEEvent] = []
        var name: String?
        var dataLines: [String] = []
        func flush() {
            if let name { events.append(SSEEvent(name: name, data: dataLines.joined(separator: "\n"))) }
            name = nil
            dataLines.removeAll()
        }
        for line in body.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("event: ") {
                flush()
                name = line.dropFirst(7).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data: ") {
                dataLines.append(String(line.dropFirst(6)))
            } else if line.isEmpty {
                flush()
            }
        }
        flush()
        return events
    }
}
