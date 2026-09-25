// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import AVFoundation
import Testing
@testable import TabMail

/// A microphone that records nothing, so no test touches audio hardware.
private final class SilentCapture: AudioCapturing {
    func prepare() {}
    func start(onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void, completion: @escaping @Sendable ((any Error)?) -> Void) {}
    func stop() {}
}

/// A finished recording through the controller: transcription, cleanup with the screen context,
/// and what gets pasted. Uses a private pasteboard and a stub keystroke, and never the network.
@MainActor
struct DictationControllerTests {
    private let transcript = "ask jordan about the road map"
    private let cleaned = "Ask Jordan about the roadmap."
    private let transcription = StubTransport()
    private let completions = StubTransport()
    private let auth = StubTransport()
    private let pasteboard = NSPasteboard(name: NSPasteboard.Name("ai.tabmail.desktop.tests.\(UUID().uuidString)"))

    /// Runs one recording through the controller; returns what was pasted.
    private func dictate(account: AccountModel? = nil) async -> (pasted: [String], controller: DictationController) {
        let account = account ?? AccountModel(client: AuthClient(transport: auth.transport), store: InMemorySessionStore(Fixtures.session()))
        var pasted: [String] = []
        let pasteboard = self.pasteboard
        let inserter = TextInserter(pasteboard: pasteboard, restoreDelay: .zero, pasteKeystroke: {
            pasted.append(pasteboard.string(forType: .string) ?? "")
        })
        let baseURL = URL(string: "https://api.example.com")!
        let transcriptionTransport = transcription.transport
        let completionsTransport = completions.transport
        let dictation = DictationController(
            permissions: PermissionsModel(),
            account: account,
            inserter: inserter,
            capture: SilentCapture(),
            makeTranscriptionClient: { TranscriptionClient(baseURL: baseURL, transport: transcriptionTransport) },
            makeCompletionsClient: { CompletionsClient(baseURL: baseURL, transport: completionsTransport) }
        )
        await dictation.transcribe(WAVEncoder.encode(pcm16Mono: Data([0, 0, 1, 0]), sampleRate: 16_000), generation: 0)
        return (pasted, dictation)
    }

    private func authorization(_ stub: StubTransport) -> [String?] {
        stub.requests.map { $0.value(forHTTPHeaderField: "Authorization") }
    }

    @Test func pastesTheCleanedUpTranscript() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))

        let (pasted, controller) = await dictate()

        #expect(pasted == [cleaned])
        #expect(controller.phase == .idle)
        #expect(completions.requests.count == 1)
        guard completions.requests.count == 1 else { return }
        let messages = Fixtures.jsonBody(of: completions.requests[0])["messages"] as? [[String: Any]]
        #expect(messages?.first?["dictation"] as? String == transcript)
        #expect(authorization(transcription) == ["Bearer access-1"])
        #expect(authorization(completions) == ["Bearer access-1"])
    }

    @Test func pastesTheTranscriptAsHeardWhenTheCleanupFails() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 500, json: ["error": "internal_error"])

        let (pasted, controller) = await dictate()

        #expect(pasted == [transcript])
        #expect(controller.phase == .idle)
    }

    @Test func anEmptyTranscriptIsNeitherCleanedUpNorPasted() async {
        transcription.enqueue(status: 200, json: ["text": "  "])

        let (pasted, controller) = await dictate()

        #expect(pasted.isEmpty)
        #expect(completions.requests.isEmpty)
        #expect(controller.phase == .failed(DictationController.nothingHeardMessage))
    }

    @Test func aFailedTranscriptionIsNeitherCleanedUpNorPasted() async {
        transcription.enqueue(status: 402, json: ["error": "no_active_subscription"])

        let (pasted, controller) = await dictate()

        #expect(pasted.isEmpty)
        #expect(completions.requests.isEmpty)
        guard case .failed = controller.phase else {
            Issue.record("expected a failure, got \(controller.phase)")
            return
        }
    }

    /// Cancelled (Escape, or a new dictation) while the cleanup runs: its result is not pasted.
    @Test func aDictationCancelledDuringTheCleanupPastesNothing() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))
        // Its own task: cancelling the test's task would cancel the test.
        let dictation = Task { await dictate() }
        completions.gate = { dictation.cancel() }

        let (pasted, _) = await dictation.value

        #expect(completions.requests.count == 1)
        #expect(pasted.isEmpty)
    }

    /// The user signed out and into another account while the transcription ran: the transcript is
    /// not sent to the cleanup under that account, and is pasted as heard.
    @Test func anAccountSwitchDuringTheTranscriptionSkipsTheCleanup() async {
        let account = AccountModel(client: AuthClient(transport: auth.transport), store: InMemorySessionStore(Fixtures.session()))
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))
        auth.enqueue(status: 200, json: Fixtures.sessionJSON(access: "access-b", refresh: "refresh-b", userId: "user-2"))
        transcription.gate = {
            await account.signOut()
            try? await account.verify(email: Fixtures.email, code: "123456")
        }

        let (pasted, _) = await dictate(account: account)

        #expect(account.session?.userId == "user-2")
        #expect(authorization(transcription) == ["Bearer access-1"])
        #expect(completions.requests.isEmpty)
        #expect(pasted == [transcript])
    }
}
