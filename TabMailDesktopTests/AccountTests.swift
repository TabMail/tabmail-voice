// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMail

@MainActor
struct AccountTests {
    // MARK: AuthClient

    @Test func sendCodeRequestsAnEmailCodeForExistingAccountsOnly() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: [:])
        let client = AuthClient(publishableKey: "pk", transport: stub.transport)

        try await client.sendCode(to: Fixtures.email)

        let request = try #require(stub.requests.first)
        #expect(request.url?.path == "/auth/v1/otp")
        #expect(request.value(forHTTPHeaderField: "apikey") == "pk")
        let body = Fixtures.jsonBody(of: request)
        #expect(body["email"] as? String == Fixtures.email)
        #expect(body["create_user"] as? Bool == false)
    }

    @Test func sendCodeReportsAnUnknownEmail() async {
        let stub = StubTransport()
        stub.enqueue(status: 422, json: ["msg": "Signups not allowed for otp"])
        let client = AuthClient(transport: stub.transport)
        await #expect(throws: AuthError.emailNotRegistered) {
            try await client.sendCode(to: Fixtures.email)
        }
    }

    @Test func verifyReturnsTheSession() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: Fixtures.sessionJSON(access: "a", refresh: "r"))
        let session = try await AuthClient(transport: stub.transport).verify(email: Fixtures.email, code: "123456")
        #expect(session.accessToken == "a")
        #expect(session.userEmail == Fixtures.email)
        let body = Fixtures.jsonBody(of: try #require(stub.requests.first))
        #expect(body["type"] as? String == "email")
        #expect(body["token"] as? String == "123456")
    }

    @Test func verifyReportsAWrongCode() async {
        let stub = StubTransport()
        stub.enqueue(status: 403, json: ["msg": "Token has expired or is invalid"])
        await #expect(throws: AuthError.invalidCode) {
            _ = try await AuthClient(transport: stub.transport).verify(email: Fixtures.email, code: "000000")
        }
    }

    @Test func refreshRejectsASessionForADifferentUser() async {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: Fixtures.sessionJSON(access: "a2", refresh: "r2", userId: "someone-else"))
        await #expect(throws: AuthError.refreshRejected) {
            _ = try await AuthClient(transport: stub.transport).refresh(Fixtures.session())
        }
    }

    // MARK: AccountModel

    @Test func verifyPersistsTheSession() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: Fixtures.sessionJSON(access: "a", refresh: "r"))
        let store = InMemorySessionStore()
        let account = AccountModel(client: AuthClient(transport: stub.transport), store: store)

        try await account.verify(email: " \(Fixtures.email) ", code: " 123456 ")

        #expect(account.isSignedIn)
        #expect(store.load()?.accessToken == "a")
        #expect(Fixtures.jsonBody(of: try #require(stub.requests.first))["token"] as? String == "123456")
    }

    @Test func freshTokenIsUsedWithoutRefreshing() async throws {
        let stub = StubTransport()
        let account = AccountModel(client: AuthClient(transport: stub.transport), store: InMemorySessionStore(Fixtures.session(access: "fresh")))
        #expect(try await account.validToken() == "fresh")
        #expect(stub.requests.isEmpty)
    }

    @Test func expiringTokenIsRefreshedAndPersisted() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: Fixtures.sessionJSON(access: "new", refresh: "refresh-2"))
        let store = InMemorySessionStore(Fixtures.session(access: "old", expiresIn: DictationConfig.tokenRefreshLeewaySeconds - 1))
        let account = AccountModel(client: AuthClient(transport: stub.transport), store: store)

        #expect(try await account.validToken() == "new")
        #expect(store.load()?.refreshToken == "refresh-2")
        #expect(Fixtures.jsonBody(of: try #require(stub.requests.first))["refresh_token"] as? String == "refresh-1")
    }

    /// Refresh tokens are single-use: concurrent callers must share one refresh.
    @Test func concurrentCallersShareOneRefresh() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: Fixtures.sessionJSON(access: "new", refresh: "refresh-2"))
        stub.enqueue(status: 200, json: Fixtures.sessionJSON(access: "newer", refresh: "refresh-3"))
        let release = AsyncStream<Void>.makeStream()
        stub.gate = { for await _ in release.stream { return } }
        let account = AccountModel(
            client: AuthClient(transport: stub.transport),
            store: InMemorySessionStore(Fixtures.session(expiresIn: 0))
        )

        async let first = account.validToken()
        async let second = account.validToken()
        // Let both callers reach the refresh before it completes.
        while stub.requests.isEmpty { await Task.yield() }
        for _ in 0..<10 { await Task.yield() }
        release.continuation.yield()
        release.continuation.finish()

        let tokens = try await [first, second]
        #expect(tokens == ["new", "new"])
        #expect(stub.requests.count == 1)
    }

    @Test func rejectedRefreshSignsOut() async {
        let stub = StubTransport()
        stub.enqueue(status: 400, json: ["error": "invalid_grant"])
        let store = InMemorySessionStore(Fixtures.session(expiresIn: 0))
        let account = AccountModel(client: AuthClient(transport: stub.transport), store: store)

        await #expect(throws: AuthError.refreshRejected) {
            _ = try await account.validToken()
        }
        #expect(!account.isSignedIn)
        #expect(store.load() == nil)
    }

    @Test func signingOutDuringARefreshDoesNotResurrectTheSession() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: Fixtures.sessionJSON(access: "new", refresh: "refresh-2"))
        let release = AsyncStream<Void>.makeStream()
        stub.gate = { for await _ in release.stream { return } }
        let store = InMemorySessionStore(Fixtures.session(expiresIn: 0))
        let account = AccountModel(client: AuthClient(transport: stub.transport), store: store)

        async let token = account.validToken()
        while stub.requests.isEmpty { await Task.yield() }
        account.signOut()
        release.continuation.yield()
        release.continuation.finish()

        _ = try? await token
        #expect(!account.isSignedIn)
        #expect(store.load() == nil)
    }

    @Test func signedOutHasNoToken() async throws {
        let account = AccountModel(client: AuthClient(transport: StubTransport().transport), store: InMemorySessionStore())
        #expect(try await account.validToken() == nil)
    }
}
