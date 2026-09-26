// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Observation

/// The signed-in TabMail account and its access token.
@MainActor
@Observable
final class AccountModel {
    private(set) var session: TabMailSession?

    @ObservationIgnored private let client: AuthClient
    @ObservationIgnored private let store: any SessionStoring
    /// Supabase refresh tokens are single-use: concurrent refreshes would invalidate each other,
    /// so every caller awaits the one in flight.
    @ObservationIgnored private var refreshTask: Task<TabMailSession, Error>?

    init(client: AuthClient = AuthClient(), store: any SessionStoring = KeychainSessionStore()) {
        self.client = client
        self.store = store
        self.session = store.load()
    }

    var isSignedIn: Bool { session != nil }
    var email: String? { session?.userEmail }

    func sendCode(to email: String) async throws {
        try await client.sendCode(to: email.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func verify(email: String, code: String) async throws {
        let session = try await client.verify(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
            code: code.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        try store.save(session)
        self.session = session
    }

    func signOut() {
        refreshTask?.cancel()
        refreshTask = nil
        store.clear()
        session = nil
    }

    /// A usable access token, refreshing first if it expires soon (or `forceRefresh`).
    /// Returns nil when signed out; signs out when the refresh token is rejected.
    func validToken(forceRefresh: Bool = false) async throws -> String? {
        if let refreshTask {
            return try await refreshTask.value.accessToken
        }
        guard let current = session else { return nil }
        if !forceRefresh && !current.expires(within: DictationConfig.tokenRefreshLeewaySeconds) {
            return current.accessToken
        }

        let client = client
        let task = Task { try await client.refresh(current) }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let refreshed = try await task.value
            // Signed out while refreshing: don't resurrect the session.
            guard session?.userId == current.userId else { return nil }
            try store.save(refreshed)
            session = refreshed
            return refreshed.accessToken
        } catch AuthError.refreshRejected {
            Log.debug("AccountModel: refresh rejected; signing out")
            signOut()
            throw AuthError.refreshRejected
        }
    }
}
