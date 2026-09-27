// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

@MainActor
struct TranscriptionClientTests {
    private let baseURL = URL(string: "https://api.example.com")!
    private let wav = Data("RIFF-test-audio".utf8)

    @Test func sendsTheRecordingToTheTranscribeEndpoint() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: ["text": "Hello there.", "duration_seconds": 1.2])
        let client = TranscriptionClient(baseURL: baseURL, clientVersion: "0.1.0", transport: stub.transport)

        let text = try await client.transcribe(wav: wav, language: nil, accessToken: "token-abc")

        #expect(text == "Hello there.")
        let request = try #require(stub.requests.first)
        #expect(request.url?.absoluteString == "https://api.example.com/dictation/transcribe")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-abc")
        #expect(request.value(forHTTPHeaderField: "X-Client-Type") == "macos")
        #expect(request.value(forHTTPHeaderField: "X-Client-Version") == "0.1.0")
        let body = Fixtures.jsonBody(of: request)
        #expect(body["format"] as? String == "wav")
        #expect(body["audio"] as? String == wav.base64EncodedString())
        #expect(body["language"] == nil)
    }

    /// The language picks the backend's model; without one, the body has no `language` at all.
    @Test func sendsTheLanguageWhenThereIsOne() async throws {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: ["text": "안녕하세요."])
        stub.enqueue(status: 200, json: ["text": "Hello."])
        let client = TranscriptionClient(baseURL: baseURL, transport: stub.transport)

        _ = try await client.transcribe(wav: wav, language: "ko", accessToken: "t")
        _ = try await client.transcribe(wav: wav, language: nil, accessToken: "t")

        #expect(stub.requests.count == 2)
        guard stub.requests.count == 2 else { return }
        #expect(Fixtures.jsonBody(of: stub.requests[0])["language"] as? String == "ko")
        #expect(Fixtures.jsonBody(of: stub.requests[1]).keys.sorted() == ["audio", "format"])
    }

    /// The debug log's copy of the body shows the language sent, beside the audio's size.
    @Test func theLoggedBodyShowsTheLanguage() {
        #expect(TranscriptionClient.loggedBody(wavBytes: 12, language: "ko").contains(#""language":"ko""#))
        #expect(!TranscriptionClient.loggedBody(wavBytes: 12, language: nil).contains("language"))
    }

    @Test(arguments: [
        (401, "invalid_token", BackendError.unauthorized),
        (402, "no_active_subscription", .subscriptionRequired),
        (403, "consent_required", .accountSetupRequired),
        (403, "Access denied", .accessDenied),
        (429, "rate_limited", .rateLimited),
        (400, "audio_too_large", .recordingTooLong),
        (502, "transcription_failed", .failed(status: 502)),
    ])
    func mapsBackendErrors(status: Int, code: String, expected: BackendError) async {
        let stub = StubTransport()
        stub.enqueue(status: status, json: ["error": code])
        let client = TranscriptionClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: expected) {
            _ = try await client.transcribe(wav: wav, language: nil, accessToken: "t")
        }
    }

    @Test func rejectsAResponseWithoutText() async {
        let stub = StubTransport()
        stub.enqueue(status: 200, json: ["unexpected": true])
        let client = TranscriptionClient(baseURL: baseURL, transport: stub.transport)
        await #expect(throws: BackendError.invalidResponse) {
            _ = try await client.transcribe(wav: wav, language: nil, accessToken: "t")
        }
    }

    /// An expired token gets exactly one retry, with a force-refreshed token.
    @Test func retriesOnceWithARefreshedTokenAfter401() async throws {
        let backend = StubTransport()
        backend.enqueue(status: 401, json: ["error": "invalid_token"])
        backend.enqueue(status: 200, json: ["text": "Retried."])
        let auth = StubTransport()
        auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-2", refresh: "refresh-2"))
        let account = AccountModel(
            client: AuthClient(transport: auth.transport),
            store: InMemorySessionStore(Fixtures.session(access: "access-1"))
        )
        let client = TranscriptionClient(baseURL: baseURL, transport: backend.transport)

        let text = try await DictationController.withFreshToken(account: account, userId: Fixtures.userId) { try await client.transcribe(wav: wav, language: nil, accessToken: $0) }

        #expect(text == "Retried.")
        #expect(backend.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer access-1", "Bearer access-2"])
        #expect(auth.requests.count == 1)
    }

    @Test func doesNotRetryOtherFailures() async {
        let backend = StubTransport()
        backend.enqueue(status: 402, json: ["error": "no_active_subscription"])
        let auth = StubTransport()
        let account = AccountModel(client: AuthClient(transport: auth.transport), store: InMemorySessionStore(Fixtures.session()))
        let client = TranscriptionClient(baseURL: baseURL, transport: backend.transport)

        await #expect(throws: BackendError.subscriptionRequired) {
            _ = try await DictationController.withFreshToken(account: account, userId: Fixtures.userId) { try await client.transcribe(wav: wav, language: nil, accessToken: $0) }
        }
        #expect(backend.requests.count == 1)
        #expect(auth.requests.isEmpty)
    }

    @Test func signedOutFailsWithoutCallingTheBackend() async {
        let backend = StubTransport()
        let account = AccountModel(client: AuthClient(transport: StubTransport().transport), store: InMemorySessionStore())
        let client = TranscriptionClient(baseURL: baseURL, transport: backend.transport)
        await #expect(throws: BackendError.unauthorized) {
            _ = try await DictationController.withFreshToken(account: account, userId: Fixtures.userId) { try await client.transcribe(wav: wav, language: nil, accessToken: $0) }
        }
        #expect(backend.requests.isEmpty)
    }

    /// A refused request can finish after sign-out or an account switch. The retry must report
    /// an ended session, not another backend failure, and must never send the recording again.
    @Test(arguments: [false, true])
    func aSessionChangeDuringTheRequestRejectsTheRetryAsUnauthorized(switchAccount: Bool) async {
        let backend = StubTransport()
        backend.enqueue(status: 401, json: ["error": "invalid_token"])
        backend.enqueue(status: 200, json: ["text": "Retried."])
        let auth = StubTransport()
        if switchAccount {
            auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-b", refresh: "refresh-b", userId: "user-2"))
            auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-b2", refresh: "refresh-b2", userId: "user-2"))
        }
        let account = AccountModel(client: AuthClient(transport: auth.transport), store: InMemorySessionStore(Fixtures.session()))
        let client = TranscriptionClient(baseURL: baseURL, transport: backend.transport)
        backend.gate = {
            await account.signOut()
            if switchAccount { try? await account.verify(email: Fixtures.email, code: "123456") }
        }

        await #expect(throws: BackendError.unauthorized) {
            _ = try await DictationController.withFreshToken(account: account, userId: Fixtures.userId) {
                try await client.transcribe(wav: wav, language: nil, accessToken: $0)
            }
        }
        #expect(backend.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer access-1"])
        #expect(account.session?.userId == (switchAccount ? "user-2" : nil))
    }
}
