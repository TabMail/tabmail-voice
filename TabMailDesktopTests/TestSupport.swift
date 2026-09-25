// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
@testable import TabMail

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

    static func jsonBody(of request: URLRequest) -> [String: Any] {
        guard let body = request.httpBody,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return [:] }
        return object
    }
}
