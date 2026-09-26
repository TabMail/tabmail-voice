// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
@testable import TabMailVoice

/// Scripted HTTP transport: records every request, answers from a queue.
final class StubTransport: @unchecked Sendable {
    struct Reply {
        let status: Int
        let body: Data
    }

    private let state = OSAllocatedUnfairLock<(requests: [URLRequest], replies: [Reply])>(initialState: ([], []))
    /// Suspends each request until the test releases it (for single-flight tests).
    var gate: (@Sendable () async -> Void)?

    func enqueue(status: Int, json: Any) {
        let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        state.withLock { $0.replies.append(Reply(status: status, body: body)) }
    }

    func enqueue(status: Int, text: String) {
        state.withLock { $0.replies.append(Reply(status: status, body: Data(text.utf8))) }
    }

    var requests: [URLRequest] { state.withLock { $0.requests } }

    var transport: HTTPTransport {
        { [self] request in
            state.withLock { $0.requests.append(request) }
            await gate?()
            let reply = state.withLock { state -> Reply? in
                state.replies.isEmpty ? nil : state.replies.removeFirst()
            }
            guard let reply else { throw URLError(.badServerResponse) }
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
            return (reply.body, response)
        }
    }
}

final class InMemorySessionStore: SessionStoring, @unchecked Sendable {
    private let stored = OSAllocatedUnfairLock<TabMailSession?>(initialState: nil)

    init(_ session: TabMailSession? = nil) {
        stored.withLock { $0 = session }
    }

    func load() -> TabMailSession? { stored.withLock { $0 } }
    func save(_ session: TabMailSession) throws { stored.withLock { $0 = session } }
    func clear() { stored.withLock { $0 = nil } }
}

/// Settings kept in memory. A real suite (`UserDefaults(suiteName:)`) is written to a plist in
/// ~/Library/Preferences, and the preferences daemon writes it again after a test deletes it, so
/// every run would leave files behind. Every accessor `AppSettings` uses is overridden; anything
/// else reaches one fixed scratch suite, never the app's own domain.
final class InMemoryDefaults: UserDefaults, @unchecked Sendable {
    private let values = OSAllocatedUnfairLock(uncheckedState: [String: Any]())

    init() {
        super.init(suiteName: "ai.tabmail.voice.tests.unused")!
    }

    override func object(forKey defaultName: String) -> Any? { values.withLockUnchecked { $0[defaultName] } }
    override func string(forKey defaultName: String) -> String? { object(forKey: defaultName) as? String }
    override func bool(forKey defaultName: String) -> Bool { object(forKey: defaultName) as? Bool ?? false }
    override func set(_ value: Any?, forKey defaultName: String) { values.withLockUnchecked { $0[defaultName] = value } }
    override func set(_ value: Bool, forKey defaultName: String) { set(value as Any?, forKey: defaultName) }
    override func removeObject(forKey defaultName: String) { set(nil as Any?, forKey: defaultName) }
}

/// A user setting that a test switches while the code under test reads it.
@MainActor
final class Switch {
    var isOn: Bool
    init(_ isOn: Bool) { self.isOn = isOn }
}

/// The `Log.content` entries logged while `body` runs (ADR-DESK-015).
final class ContentLogEntries: Sendable {
    private let state = OSAllocatedUnfairLock<[(label: String, text: String)]>(initialState: [])
    var all: [(label: String, text: String)] { state.withLock { $0 } }
    var joined: String { all.map { "\($0.label)\n\($0.text)" }.joined(separator: "\n") }
    /// The entries whose label starts with none of `excluded` (the backend clients' own entries, say).
    func all(excluding excluded: [String]) -> [(label: String, text: String)] {
        all.filter { entry in !excluded.contains { entry.label.hasPrefix($0) } }
    }
    func add(_ label: String, _ text: String) { state.withLock { $0.append((label, text)) } }

    static func logged(isolation: isolated (any Actor)? = #isolation, _ body: () async throws -> Void) async rethrows -> ContentLogEntries {
        let entries = ContentLogEntries()
        try await Log.$contentObserver.withValue({ entries.add($0, $1) }) { try await body() }
        return entries
    }
}

enum Fixtures {
    static let userId = "user-1"
    static let email = "person@example.com"

    static func session(access: String = "access-1", refresh: String = "refresh-1", expiresIn seconds: Int = 3600, userId: String = userId) -> TabMailSession {
        TabMailSession(
            accessToken: access,
            refreshToken: refresh,
            expiresAt: Int(Date().timeIntervalSince1970) + seconds,
            userId: userId,
            userEmail: email
        )
    }

    static func sessionJSON(access: String, refresh: String, expiresIn seconds: Int = 3600, userId: String = userId) -> [String: Any] {
        [
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": Int(Date().timeIntervalSince1970) + seconds,
            "user": ["id": userId, "email": email],
        ]
    }

    /// What `POST /completions/chat` streams: a comment primer, keepalives while the model works,
    /// then a `final` event with the given payload.
    static func completionsStream(final: String) -> String {
        ": \(String(repeating: " ", count: 20))\n\nevent: keepalive\ndata: {}\n\nevent: keepalive\ndata: {}\n\nevent: final\ndata: \(final)\n\n"
    }

    static func jsonBody(of request: URLRequest) -> [String: Any] {
        guard let body = request.httpBody,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return [:] }
        return object
    }
}
