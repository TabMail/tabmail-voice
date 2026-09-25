// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import Observation

/// Drives one push-to-talk dictation at a time: record → transcribe on the backend → paste.
@MainActor
@Observable
final class DictationController {
    enum Phase: Equatable {
        case idle
        case listening
        case transcribing
        case failed(String)
    }

    private(set) var phase: Phase = .idle {
        didSet { onPhaseChange?(phase) }
    }
    private(set) var level: Float = 0

    @ObservationIgnored var onPhaseChange: ((Phase) -> Void)?

    @ObservationIgnored private let permissions: PermissionsModel
    @ObservationIgnored private let account: AccountModel
    @ObservationIgnored private let makeTranscriptionClient: @MainActor () -> TranscriptionClient
    @ObservationIgnored private let inserter: TextInserter
    @ObservationIgnored private let clock = ContinuousClock()

    // Per-dictation state. `generation` invalidates callbacks from a superseded dictation.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var startedAt: ContinuousClock.Instant?
    @ObservationIgnored private var capture: MicrophoneCapture?
    @ObservationIgnored private var recorder: AudioRecorder?
    @ObservationIgnored private var maxDurationTask: Task<Void, Never>?
    @ObservationIgnored private var transcriptionTask: Task<Void, Never>?
    @ObservationIgnored private var failureResetTask: Task<Void, Never>?

    init(
        permissions: PermissionsModel,
        account: AccountModel,
        inserter: TextInserter = TextInserter(),
        makeTranscriptionClient: @escaping @MainActor () -> TranscriptionClient
    ) {
        self.permissions = permissions
        self.account = account
        self.inserter = inserter
        self.makeTranscriptionClient = makeTranscriptionClient
    }

    func handle(_ action: PushToTalkGesture.Action) {
        switch action {
        case .start: start()
        case .finish: finish()
        case .cancel: cancel()
        }
    }

    /// Menu-driven toggle, for users who prefer clicking to holding a key.
    func toggle() {
        if phase == .listening { finish() } else { start() }
    }

    func start() {
        switch phase {
        case .idle, .failed: break
        case .listening, .transcribing: return
        }
        guard account.isSignedIn else {
            fail("Sign in to TabMail in Settings to dictate.")
            return
        }
        guard permissions.microphone == .authorized else {
            fail("Allow microphone access in TabMail's menu to dictate.")
            return
        }
        guard permissions.accessibilityTrusted else {
            fail("Allow Accessibility access in TabMail's menu so dictation can type for you.")
            return
        }

        failureResetTask?.cancel()
        generation += 1
        let current = generation
        level = 0
        startedAt = clock.now
        phase = .listening

        let recorder = AudioRecorder()
        let capture = MicrophoneCapture()
        self.recorder = recorder
        self.capture = capture
        do {
            _ = try capture.start { [weak self] buffer in
                recorder.append(buffer)
                let level = MicrophoneCapture.level(of: buffer)
                Task { @MainActor [weak self] in self?.updateLevel(level, generation: current) }
            }
        } catch {
            Log.error("DictationController: microphone start failed: \(type(of: error))")
            teardown()
            fail("Couldn't start the microphone.")
            return
        }

        // Past the upload cap, stop and send what was said rather than silently dropping audio.
        maxDurationTask = Task { [weak self] in
            try? await Task.sleep(for: DictationConfig.maxRecordingDuration)
            guard !Task.isCancelled, let self, self.generation == current else { return }
            Log.debug("DictationController: max duration reached; finishing")
            self.finish()
        }
        Log.debug("DictationController: listening (generation \(current))")
    }

    func finish() {
        guard phase == .listening, let startedAt, recorder != nil else { return }
        maxDurationTask?.cancel()

        if clock.now - startedAt < DictationConfig.minimumHoldDuration {
            Log.debug("DictationController: hold too short; discarding")
            discard()
            return
        }

        // Keep the microphone open briefly after release so the last word isn't clipped.
        let current = generation
        phase = .transcribing
        level = 0
        transcriptionTask = Task { [weak self] in
            try? await Task.sleep(for: DictationConfig.releaseTailDuration)
            guard !Task.isCancelled, let self, self.generation == current else { return }
            await self.completeRecording(generation: current)
        }
    }

    func cancel() {
        guard phase == .listening || phase == .transcribing else { return }
        Log.debug("DictationController: cancelled")
        discard()
    }

    private func completeRecording(generation current: Int) async {
        capture?.stop()
        capture = nil
        guard let recorder else { return }

        let recording: AudioRecorder.Recording
        do {
            recording = try recorder.finish()
        } catch {
            Log.error("DictationController: recording failed: \(type(of: error))")
            teardown()
            fail("Couldn't record audio.")
            return
        }
        let micDelay = recording.firstBufferAt.map { "\($0 - (startedAt ?? $0))" } ?? "no audio"
        Log.debug("DictationController: recorded \(recording.duration)s, speech \(recording.speechSeconds)s, peak \(recording.peakLevel), first audio after \(micDelay)")

        let wav = WAVEncoder.encode(pcm16Mono: recording.pcm, sampleRate: recording.sampleRate)
        #if DEBUG
        Self.keepForPlayback(wav)
        #endif

        guard recording.containsSpeech else {
            Log.debug("DictationController: too quiet; not uploading")
            teardown()
            fail("Too quiet — nothing to type. Hold the key and speak.")
            return
        }
        await transcribe(wav, generation: current)
    }

    private func transcribe(_ wav: Data, generation current: Int) async {
        Log.debug("DictationController: uploading \(wav.count) bytes")
        do {
            let text = try await Self.transcribeWithFreshToken(wav, client: makeTranscriptionClient(), account: account)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard generation == current, !Task.isCancelled else { return }
            Log.debug("DictationController: transcript ready (\(text.count) chars)")
            if !text.isEmpty {
                await inserter.insert(text)
            }
            guard generation == current else { return }
            teardown()
            phase = .idle
        } catch {
            guard generation == current, !Task.isCancelled else { return }
            Log.error("DictationController: transcription failed: \(type(of: error))")
            teardown()
            fail(error.localizedDescription)
        }
    }

    /// One retry with a forced token refresh if the backend says the token is no longer valid.
    static func transcribeWithFreshToken(_ wav: Data, client: TranscriptionClient, account: AccountModel) async throws -> String {
        guard let token = try await account.validToken() else { throw TranscriptionError.unauthorized }
        do {
            return try await client.transcribe(wav: wav, accessToken: token)
        } catch TranscriptionError.unauthorized {
            guard let fresh = try await account.validToken(forceRefresh: true) else {
                throw TranscriptionError.unauthorized
            }
            return try await client.transcribe(wav: wav, accessToken: fresh)
        }
    }

    #if DEBUG
    /// Debug builds only: overwrites one temp file with the latest recording so a developer can
    /// listen to exactly what was (or would have been) uploaded. Compiled out of Release.
    private static func keepForPlayback(_ wav: Data) {
        do {
            try wav.write(to: DictationConfig.debugLastRecordingURL, options: .atomic)
        } catch {
            Log.debug("DictationController: couldn't keep last recording: \(type(of: error))")
        }
    }
    #endif

    private func updateLevel(_ newLevel: Float, generation: Int) {
        guard generation == self.generation, phase == .listening else { return }
        level += (newLevel - level) * DictationConfig.levelSmoothing
    }

    private func discard() {
        generation += 1
        transcriptionTask?.cancel()
        teardown()
        phase = .idle
    }

    private func teardown() {
        capture?.stop()
        capture = nil
        recorder = nil
        maxDurationTask?.cancel()
        maxDurationTask = nil
        transcriptionTask = nil
        startedAt = nil
        level = 0
    }

    private func fail(_ message: String) {
        phase = .failed(message)
        failureResetTask?.cancel()
        failureResetTask = Task { [weak self] in
            try? await Task.sleep(for: DictationConfig.overlayErrorDisplayDuration)
            guard !Task.isCancelled, let self, case .failed = self.phase else { return }
            self.phase = .idle
        }
    }
}
