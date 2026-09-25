// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// HTTP transport, injectable so tests never touch the network.
typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

enum HTTP {
    static let live: HTTPTransport = { request in
        try await URLSession.shared.data(for: request)
    }
}

enum AuthError: LocalizedError, Equatable {
    case emailNotRegistered
    case invalidCode
    case refreshRejected
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .emailNotRegistered: "No TabMail account uses that email. Sign up at tabmail.ai first."
        case .invalidCode: "That code is wrong or has expired."
        case .refreshRejected: "Your session has ended. Please sign in again."
        case .failed(let message): message
        }
    }
}

/// Supabase GoTrue email-code sign-in and token refresh (same flow as iOS `TabMailAuthService`).
struct AuthClient: Sendable {
    let baseURL: URL
    let publishableKey: String
    let transport: HTTPTransport

    init(
        baseURL: URL = DictationConfig.authBaseURL,
        publishableKey: String = DictationConfig.authPublishableKey,
        transport: @escaping HTTPTransport = HTTP.live
    ) {
        self.baseURL = baseURL
        self.publishableKey = publishableKey
        self.transport = transport
    }

    /// Emails a one-time code. Existing accounts only: sign-up happens on tabmail.ai.
    func sendCode(to email: String) async throws {
        let (data, status) = try await post("auth/v1/otp", body: ["email": email, "create_user": false])
        guard status == 200 else {
            let message = Self.errorMessage(data) ?? "Couldn't send the code (HTTP \(status))."
            if message.contains("not found") || message.contains("not allowed") || message.contains("Signups") {
                throw AuthError.emailNotRegistered
            }
            throw AuthError.failed(message)
        }
    }

    func verify(email: String, code: String) async throws -> TabMailSession {
        let (data, status) = try await post("auth/v1/verify", body: ["email": email, "token": code, "type": "email"])
        guard status == 200 else {
            let message = Self.errorMessage(data) ?? "Verification failed (HTTP \(status))."
            if message.contains("Invalid") || message.contains("expired") {
                throw AuthError.invalidCode
            }
            throw AuthError.failed(message)
        }
        return try JSONDecoder().decode(TabMailSession.self, from: data)
    }

    func refresh(_ session: TabMailSession) async throws -> TabMailSession {
        let (data, status) = try await post(
            "auth/v1/token",
            query: [URLQueryItem(name: "grant_type", value: "refresh_token")],
            body: ["refresh_token": session.refreshToken]
        )
        if [400, 401, 403].contains(status) { throw AuthError.refreshRejected }
        guard status == 200 else { throw AuthError.failed("Couldn't refresh your session (HTTP \(status)).") }
        let refreshed = try JSONDecoder().decode(TabMailSession.self, from: data)
        guard refreshed.userId == session.userId else { throw AuthError.refreshRejected }
        return refreshed
    }

    private func post(_ path: String, query: [URLQueryItem] = [], body: [String: Any]) async throws -> (Data, Int) {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw AuthError.failed("Invalid auth URL.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = DictationConfig.authRequestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(publishableKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else { throw AuthError.failed("Invalid response.") }
        return (data, http.statusCode)
    }

    private static func errorMessage(_ data: Data) -> String? {
        guard let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return info["msg"] as? String ?? info["error_description"] as? String ?? info["error"] as? String
    }
}
