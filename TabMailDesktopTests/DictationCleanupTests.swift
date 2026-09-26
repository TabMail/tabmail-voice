// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
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
        // The backend's prompt name, spelled out: comparing with the config would pass a typo.
        #expect(message.content == "system_prompt_dictate_cleanup")
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

/// The timeout returns the operation's error or its own deadline error, even if the operation
/// cannot respond to cancellation. A watchdog keeps a lost continuation from hanging the tests.
struct AsyncTimeoutTests {
    private enum Failure: Error, Equatable {
        case example
    }

    /// Cleanup's fallback hides error types; callers of the timeout must still get the original error.
    @Test func passesThroughTheOperationsError() async throws {
        let result = try #require(await Self.result(seconds: 30) { throw Failure.example })

        #expect(throws: Failure.example) { _ = try result.get() }
    }

    /// Awaiting an independent task ignores cancellation until that task finishes. The deadline
    /// must release the caller first; only then does the test let the operation finish.
    @Test func timesOutWithoutWaitingForAnOperationThatIgnoresCancellation() async throws {
        let (gate, opener) = AsyncStream.makeStream(of: Never.self)
        let blocked = Task.detached {
            for await _ in gate {}
            return "late reply"
        }
        defer { opener.finish() }
        let result = try #require(await Self.result(seconds: 0.2) { await blocked.value })

        guard case .failure(let error) = result else {
            Issue.record("expected a timeout before releasing the operation")
            return
        }
        let timeout = try #require(error as? TimeoutError)
        #expect(timeout.duration == 0.2)
        #expect(timeout.description == "Operation timed out after 0.2s")
    }

    /// The task under test never occupies the watchdog's thread, and is cancelled on every exit.
    private static func result(seconds: TimeInterval, operation: @escaping @Sendable () async throws -> String) async -> Result<String, any Error>? {
        let output = OSAllocatedUnfairLock<Result<String, any Error>?>(initialState: nil)
        let returned = DispatchSemaphore(value: 0)
        let task = Task.detached {
            do {
                let value = try await withTimeout(seconds: seconds, operation: operation)
                output.withLock { $0 = .success(value) }
            } catch {
                output.withLock { $0 = .failure(error) }
            }
            returned.signal()
        }
        defer { task.cancel() }
        let inTime = await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: returned.wait(timeout: .now() + 10) == .success)
            }
        }
        #expect(inTime)
        guard inTime else { return nil }
        return output.withLock { $0 }
    }
}

/// What gets pasted: the cleaned-up text, or the transcript as heard whenever the cleanup fails.
@MainActor
struct DictationCleanupFallbackTests {
    private let transcript = "ask jordan about the road map"
    private let backend = StubTransport()
    private let auth = StubTransport()

    private func account(_ session: TabMailSession? = Fixtures.session()) -> AccountModel {
        AccountModel(client: AuthClient(transport: auth.transport), store: InMemorySessionStore(session))
    }

    /// A cleanup of a dictation transcribed under `Fixtures.userId`.
    private func cleanUp(_ account: AccountModel? = nil, timeout: TimeInterval = DictationConfig.cleanupTimeout) async -> String {
        let client = CompletionsClient(baseURL: URL(string: "https://api.example.com")!, transport: backend.transport)
        return await DictationCleanup.cleanUp(transcript, context: nil, client: client, account: account ?? self.account(), userId: Fixtures.userId, timeout: timeout)
    }

    private var authorizations: [String?] {
        backend.requests.map { $0.value(forHTTPHeaderField: "Authorization") }
    }

    @Test func pastesTheCleanedUpText() async {
        backend.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":" Ask Jordan about the roadmap.\n"}"#))

        #expect(await cleanUp() == "Ask Jordan about the roadmap.")
        #expect(backend.requests.count == 1)
        guard backend.requests.count == 1 else { return }
        let messages = Fixtures.jsonBody(of: backend.requests[0])["messages"] as? [[String: Any]]
        #expect(messages?.first?["dictation"] as? String == transcript)
    }

    /// Only an empty reply is a malfunction; even one character can be the whole dictation.
    @Test func aSingleCharacterReplyIsStillUsed() async {
        backend.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"é"}"#))

        #expect(await cleanUp() == "é")
    }

    /// A cleanup still running at its timeout is abandoned: the transcript is pasted as heard,
    /// without waiting for the reply, and the request is cancelled.
    @Test func aCleanupPastItsTimeoutPastesTheTranscriptAsHeard() async {
        backend.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))
        let cancelled = OSAllocatedUnfairLock(initialState: false)
        backend.gate = {
            do { try await Task.sleep(for: .seconds(5)) } catch { cancelled.withLock { $0 = true } }
        }
        let clock = ContinuousClock()
        let started = clock.now

        #expect(await cleanUp(timeout: 0.2) == transcript)
        #expect(clock.now - started < .seconds(2))
        #expect(backend.requests.count == 1)
        let deadline = clock.now + .seconds(1)
        while !cancelled.withLock({ $0 }), clock.now < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(cancelled.withLock { $0 })
    }

    /// A reply within the timeout is used.
    @Test func aCleanupWithinItsTimeoutPastesTheCleanedUpText() async {
        backend.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))
        backend.gate = { try? await Task.sleep(for: .milliseconds(100)) }

        #expect(await cleanUp(timeout: 2) == "Ask Jordan about the roadmap.")
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
        #expect(await cleanUp(account(nil)) == transcript)
        #expect(backend.requests.isEmpty)
    }

    @Test func anExpiredTokenIsRefreshedOnceAndTheCleanupRetried() async {
        backend.enqueue(status: 401, json: ["error": "invalid_token"])
        backend.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))
        auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-2", refresh: "refresh-2"))

        #expect(await cleanUp() == "Ask Jordan about the roadmap.")
        #expect(authorizations == ["Bearer access-1", "Bearer access-2"])
        #expect(auth.requests.count == 1)
    }

    @Test func aTokenRejectedAgainAfterTheRefreshPastesTheTranscriptAsHeard() async {
        backend.enqueue(status: 401, json: ["error": "invalid_token"])
        backend.enqueue(status: 401, json: ["error": "invalid_token"])
        auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-2", refresh: "refresh-2"))

        #expect(await cleanUp() == transcript)
        #expect(authorizations == ["Bearer access-1", "Bearer access-2"])
        #expect(auth.requests.count == 1)
    }

    @Test func aRejectedRefreshPastesTheTranscriptAsHeard() async {
        backend.enqueue(status: 401, json: ["error": "invalid_token"])
        auth.enqueue(status: 400, json: ["error": "invalid_grant"])

        #expect(await cleanUp() == transcript)
        #expect(backend.requests.count == 1)
    }

    // MARK: Another account

    /// The user signed out and into another account after the dictation was transcribed.
    @Test func aDictationIsNotCleanedUpUnderAnotherAccount() async {
        #expect(await cleanUp(account(Fixtures.session(access: "access-b", userId: "user-2"))) == transcript)
        #expect(backend.requests.isEmpty)
    }

    /// The switch happens while the first request is in flight: the retry must not go out under the
    /// other account's token.
    @Test func aSwitchDuringTheRequestStopsTheRetry() async {
        let account = account()
        backend.enqueue(status: 401, json: ["error": "invalid_token"])
        backend.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))
        auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-b", refresh: "refresh-b", userId: "user-2"))
        auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-b2", refresh: "refresh-b2", userId: "user-2"))
        backend.gate = {
            await account.signOut()
            try? await account.verify(email: Fixtures.email, code: "123456")
        }

        #expect(await cleanUp(account) == transcript)
        #expect(authorizations == ["Bearer access-1"])
        #expect(account.session?.userId == "user-2")
    }
}
