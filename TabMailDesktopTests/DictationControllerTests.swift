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

/// A microphone that hears a tenth of a second of tone as soon as it starts.
private final class ToneCapture: AudioCapturing {
    func prepare() {}
    func start(onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void, completion: @escaping @Sendable ((any Error)?) -> Void) {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1_600)!
        buffer.frameLength = 1_600
        for frame in 0..<Int(buffer.frameLength) {
            buffer.floatChannelData![0][frame] = 0.5 * sin(2 * .pi * 440 * Float(frame) / 16_000)
        }
        onBuffer(buffer)
        completion(nil)
    }
    func stop() {}
}

/// What the stub keystroke pasted, in order.
@MainActor
private final class Pastes {
    var texts: [String] = []
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

    private var cleanedStream: String { Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#) }

    /// A controller with both grants, signed in to `account`, on the stub backend.
    private func makeController(account: AccountModel? = nil, capture: any AudioCapturing = SilentCapture()) -> (DictationController, Pastes) {
        let account = account ?? AccountModel(client: AuthClient(transport: auth.transport), store: InMemorySessionStore(Fixtures.session()))
        let pastes = Pastes()
        let pasteboard = self.pasteboard
        let inserter = TextInserter(pasteboard: pasteboard, restoreDelay: .zero, pasteKeystroke: {
            pastes.texts.append(pasteboard.string(forType: .string) ?? "")
        })
        let baseURL = URL(string: "https://api.example.com")!
        let transcriptionTransport = transcription.transport
        let completionsTransport = completions.transport
        let dictation = DictationController(
            permissions: PermissionsModel(microphone: .authorized, accessibilityTrusted: true),
            account: account,
            inserter: inserter,
            capture: capture,
            makeTranscriptionClient: { TranscriptionClient(baseURL: baseURL, transport: transcriptionTransport) },
            makeCompletionsClient: { CompletionsClient(baseURL: baseURL, transport: completionsTransport) }
        )
        return (dictation, pastes)
    }

    /// Runs one recording through the controller; returns what was pasted.
    private func dictate(account: AccountModel? = nil) async -> (pasted: [String], controller: DictationController) {
        let (dictation, pastes) = makeController(account: account)
        await dictation.transcribe(WAVEncoder.encode(pcm16Mono: Data([0, 0, 1, 0]), sampleRate: 16_000), generation: 0)
        return (pastes.texts, dictation)
    }

    /// Holds the dictation key past the reveal delay, then releases it.
    private func holdAndRelease(_ controller: DictationController) async {
        controller.handle(.start)
        #expect(await eventually { controller.phase == .listening })
        controller.handle(.finish)
    }

    /// Polls `condition` until it holds, for up to five seconds.
    private func eventually(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            guard ContinuousClock.now < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return true
    }

    /// A screen with `sentinel` in its app name and text.
    private func screen(_ sentinel: String) -> ScreenContext {
        ScreenContext(appName: "Example Notes \(sentinel)", windowTitle: "Weekly sync", blocks: [.init(kind: .text, text: "Agenda \(sentinel)")])
    }

    /// A screen read that finishes only once `release` is called.
    private func pendingRead(_ context: ScreenContext) -> (task: Task<ScreenContext, Never>, release: () -> Void) {
        let (gate, opener) = AsyncStream.makeStream(of: Never.self)
        let task = Task {
            for await _ in gate {}
            return context
        }
        return (task, { opener.finish() })
    }

    /// The variables of the `index`th cleanup request.
    private func cleanupVars(_ index: Int) -> [String: Any]? {
        guard completions.requests.indices.contains(index) else { return nil }
        return (Fixtures.jsonBody(of: completions.requests[index])["messages"] as? [[String: Any]])?.first
    }

    private func authorization(_ stub: StubTransport) -> [String?] {
        stub.requests.map { $0.value(forHTTPHeaderField: "Authorization") }
    }

    @Test func pastesTheCleanedUpTranscript() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)

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

    // MARK: Key-down to paste

    /// The screen is read at key-down; the cleanup waits for that read and sends it with the transcript.
    @Test func cleansUpWithTheScreenReadAtKeyDown() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        let (controller, pastes) = makeController(capture: ToneCapture())
        let read = pendingRead(screen("A"))
        controller.captureContext = { read.task }

        await holdAndRelease(controller)
        #expect(await eventually { transcription.requests.count == 1 })
        try? await Task.sleep(for: .milliseconds(200))
        #expect(completions.requests.isEmpty)
        #expect(pastes.texts.isEmpty)
        read.release()

        #expect(await eventually { controller.phase == .idle && !pastes.texts.isEmpty })
        #expect(pastes.texts == [cleaned])
        #expect(cleanupVars(0)?["dictation"] as? String == transcript)
        #expect(cleanupVars(0)?["app_name"] as? String == "Example Notes A")
        #expect((cleanupVars(0)?["screen_text"] as? String)?.contains("Agenda A") == true)
    }

    /// Cancelled while its screen is still being read: nothing is sent to the cleanup or pasted, and
    /// the next dictation is cleaned up with its own screen.
    @Test func aDictationCancelledWhileItsScreenIsReadIsNotCleanedUp() async {
        transcription.enqueue(status: 200, json: ["text": "first dictation"])
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        let (controller, pastes) = makeController(capture: ToneCapture())
        let first = pendingRead(screen("A"))
        controller.captureContext = { first.task }

        await holdAndRelease(controller)
        #expect(await eventually { transcription.requests.count == 1 })
        try? await Task.sleep(for: .milliseconds(200))
        controller.handle(.cancel)
        first.release()
        try? await Task.sleep(for: .milliseconds(200))
        #expect(completions.requests.isEmpty)
        #expect(pastes.texts.isEmpty)
        #expect(controller.phase == .idle)

        let second = screen("B")
        controller.captureContext = { Task { second } }
        await holdAndRelease(controller)

        #expect(await eventually { controller.phase == .idle && !pastes.texts.isEmpty })
        #expect(pastes.texts == [cleaned])
        #expect(completions.requests.count == 1)
        #expect(cleanupVars(0)?["dictation"] as? String == transcript)
        #expect(cleanupVars(0)?["app_name"] as? String == "Example Notes B")
    }
}
