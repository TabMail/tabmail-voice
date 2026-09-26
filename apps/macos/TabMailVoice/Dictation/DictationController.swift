// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import Observation

/// Drives one push-to-talk dictation at a time: record → transcribe on the backend → clean up the
/// transcript with the screen context → paste. In agent mode (a double tap) the transcript is a request
/// instead: the agent chooses a tool, the tool writes the text, and that is pasted.
@MainActor
@Observable
final class DictationController {
    enum Phase: Equatable {
        case idle
        /// Key is down and the microphone is booting, but the hold isn't yet long enough to be
        /// deliberate: nothing is shown, so an accidental tap stays invisible and the
        /// microphone's start-up time is hidden behind the hold.
        case arming
        case listening
        case transcribing
        /// Agent mode: the agent chose this tool, which is writing its text.
        case running(AgentTool)
        case failed(String)
    }

    private(set) var phase: Phase = .idle {
        didSet { onPhaseChange?(phase) }
    }
    /// What the current (or last) recording is for.
    private(set) var mode: DictationMode = .dictation
    private(set) var level: Float = 0
    @ObservationIgnored private var envelope = LevelEnvelope()
    /// Debug tuning aid: the highest waveform level reached this dictation.
    @ObservationIgnored private var peakMeterLevel: Float = 0
    /// True once the microphone delivers audio; until then the overlay shows its warm-up swirl.
    private(set) var isHearing = false

    @ObservationIgnored var onPhaseChange: ((Phase) -> Void)?
    /// Starts reading the screen context when a dictation starts (key-down), with the target app
    /// still frontmost. Nil result: no context (the cleanup runs without it).
    @ObservationIgnored var captureContext: (() -> Task<ScreenContext, Never>?)?
    /// How long the cleanup waits for that read once the transcript is ready. Internal for tests.
    @ObservationIgnored var contextWait = DictationConfig.contextWait
    /// How long agent mode waits for that read. Internal for tests.
    @ObservationIgnored var agentContextWait = DictationConfig.agentContextWait

    @ObservationIgnored private let permissions: PermissionsModel
    @ObservationIgnored private let hasConsented: @MainActor () -> Bool
    @ObservationIgnored private let account: AccountModel
    @ObservationIgnored private let makeTranscriptionClient: @MainActor () -> TranscriptionClient
    @ObservationIgnored private let makeCompletionsClient: @MainActor () -> CompletionsClient
    @ObservationIgnored private let inserter: TextInserter
    @ObservationIgnored private let capture: any AudioCapturing
    @ObservationIgnored private let clock = ContinuousClock()

    // Per-dictation state. `generation` invalidates callbacks from a superseded dictation.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var startedAt: ContinuousClock.Instant?
    @ObservationIgnored private var recorder: AudioRecorder?
    @ObservationIgnored private var contextTask: Task<ScreenContext, Never>?
    @ObservationIgnored private var revealTask: Task<Void, Never>?
    @ObservationIgnored private var maxDurationTask: Task<Void, Never>?
    @ObservationIgnored private var transcriptionTask: Task<Void, Never>?
    @ObservationIgnored private var failureResetTask: Task<Void, Never>?

    init(
        permissions: PermissionsModel,
        hasConsented: @escaping @MainActor () -> Bool,
        account: AccountModel,
        inserter: TextInserter = TextInserter(),
        capture: any AudioCapturing = MicrophoneCapture(),
        makeTranscriptionClient: @escaping @MainActor () -> TranscriptionClient,
        makeCompletionsClient: @escaping @MainActor () -> CompletionsClient
    ) {
        self.permissions = permissions
        self.hasConsented = hasConsented
        self.account = account
        self.inserter = inserter
        self.capture = capture
        self.makeTranscriptionClient = makeTranscriptionClient
        self.makeCompletionsClient = makeCompletionsClient
    }

    func handle(_ action: PushToTalkGesture.Action) {
        switch action {
        case .start(let mode): start(mode)
        case .finish: finish()
        case .cancel: cancel()
        }
    }

    /// Does the slow, microphone-off part of starting the microphone ahead of the first dictation.
    func prewarm() {
        guard permissions.microphone == .authorized else { return }
        capture.prepare()
    }

    /// Menu-driven toggle, for users who prefer clicking to holding a key.
    func toggle() {
        if phase == .listening { finish() } else { start(.dictation) }
    }

    func start(_ mode: DictationMode) {
        switch phase {
        case .idle, .failed: break
        case .arming, .listening, .transcribing, .running: return
        }
        guard hasConsented() else {
            fail("Finish setting up TabMail Voice from its menu to dictate.")
            return
        }
        guard account.isSignedIn else {
            fail("Sign in to TabMail in Settings to dictate.")
            return
        }
        guard permissions.microphone == .authorized else {
            fail("Allow microphone access in TabMail Voice's menu to dictate.")
            return
        }
        guard permissions.accessibilityTrusted else {
            fail("Allow Accessibility access in TabMail Voice's menu so dictation can type for you.")
            return
        }

        failureResetTask?.cancel()
        generation += 1
        let current = generation
        self.mode = mode
        level = 0
        peakMeterLevel = 0
        envelope = LevelEnvelope()
        isHearing = false
        startedAt = clock.now
        phase = .arming
        contextTask = captureContext?()

        // Boot the microphone now, off the main thread; the overlay appears only once the hold
        // is long enough, by which time most of the start-up is done.
        let recorder = AudioRecorder()
        self.recorder = recorder
        capture.start(
            onBuffer: { [weak self] buffer in
                recorder.append(buffer)
                let decibels = MicrophoneCapture.decibels(of: buffer)
                Task { @MainActor [weak self] in self?.updateLevel(decibels: decibels, generation: current) }
            },
            completion: { [weak self] error in
                guard let error else { return }
                Task { @MainActor [weak self] in self?.microphoneFailed(error, generation: current) }
            }
        )
        revealTask = Task { [weak self] in
            try? await Task.sleep(for: DictationConfig.minimumHoldDuration)
            guard !Task.isCancelled, let self, self.generation == current, self.phase == .arming else { return }
            self.phase = .listening
        }

        // Past the upload cap, stop and send what was said rather than silently dropping audio.
        maxDurationTask = Task { [weak self] in
            try? await Task.sleep(for: DictationConfig.maxRecordingDuration)
            guard !Task.isCancelled, let self, self.generation == current else { return }
            Log.debug("DictationController: max duration reached; finishing")
            self.finish()
        }
        Log.debug("DictationController: arming \(mode) (generation \(current))")
    }

    func finish() {
        switch phase {
        case .arming:
            // Released before the hold became deliberate: an accidental tap. Nothing was shown.
            Log.debug("DictationController: hold too short; discarding")
            discard()
            return
        case .listening:
            break
        case .idle, .transcribing, .running, .failed:
            return
        }
        guard recorder != nil else { return }
        maxDurationTask?.cancel()

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
        switch phase {
        case .arming, .listening, .transcribing, .running:
            Log.debug("DictationController: cancelled")
            discard()
        case .idle, .failed:
            return
        }
    }

    private func microphoneFailed(_ error: any Error, generation current: Int) {
        guard generation == current else { return }
        Log.error("DictationController: microphone start failed: \(type(of: error))")
        generation += 1
        teardown()
        fail("Couldn't start the microphone.")
    }

    private func completeRecording(generation current: Int) async {
        capture.stop()
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
        Log.debug("DictationController: recorded \(recording.duration)s, peak \(recording.peakLevel), waveform peak \(peakMeterLevel), first audio after \(micDelay)")

        let wav = WAVEncoder.encode(pcm16Mono: recording.pcm, sampleRate: recording.sampleRate)
        #if DEBUG
        Self.keepForPlayback(wav)
        #endif

        // No loudness gate: on quiet built-in microphones speech sits only a few dB above the
        // room noise, so any level threshold rejects real speech. The model decides; an empty
        // transcript is reported below.
        guard !recording.pcm.isEmpty else {
            Log.debug("DictationController: no audio captured; not uploading")
            teardown()
            fail(Self.nothingHeardMessage)
            return
        }
        await transcribe(wav, generation: current)
    }

    /// Transcribes one recording, then cleans it up and inserts it (dictation) or carries it out (agent
    /// mode). Internal for tests.
    func transcribe(_ wav: Data, generation current: Int) async {
        Log.debug("DictationController: uploading \(wav.count) bytes")
        // Both requests go under the account signed in now, even if the user switches accounts
        // while they run.
        let userId = account.session?.userId
        do {
            let client = makeTranscriptionClient()
            let transcript = try await Self.withFreshToken(account: account, userId: userId) { try await client.transcribe(wav: wav, accessToken: $0) }
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard generation == current, !Task.isCancelled else { return }
            Log.debug("DictationController: transcript ready (\(transcript.count) chars)")
            guard !transcript.isEmpty else {
                teardown()
                fail(Self.nothingHeardMessage)
                return
            }
            // The screen context read at key-down, if it is done in time: best effort (ADR-DESK-008).
            let read = contextTask
            let context = try? await withTimeout(seconds: mode == .agent ? agentContextWait : contextWait) { await read?.value }
            if read != nil, context == nil { Log.debug("DictationController: screen read not done in time; continuing without it") }
            guard generation == current, !Task.isCancelled else { return }
            switch mode {
            case .dictation:
                let text = await DictationCleanup.cleanUp(transcript, context: context, client: makeCompletionsClient(), account: account, userId: userId)
                guard generation == current, !Task.isCancelled else { return }
                await inserter.insert(text)
            case .agent:
                let client = makeCompletionsClient()
                let tool = try await DesktopAgent.chooseTool(for: transcript, context: context, client: client, account: account, userId: userId)
                guard generation == current, !Task.isCancelled else { return }
                Log.debug("DictationController: agent chose \(tool.rawValue)")
                phase = .running(tool)
                let text = try await DesktopAgent.write(tool, for: transcript, context: context, client: client, account: account, userId: userId)
                guard generation == current, !Task.isCancelled else { return }
                // A compose goes after the selection; pasting over it would replace the user's text.
                if tool == .compose, !DesktopAgent.selection(in: context).isEmpty { await inserter.collapseSelection() }
                await inserter.insert(text)
            }
            guard generation == current else { return }
            teardown()
            phase = .idle
        } catch {
            guard generation == current, !Task.isCancelled else { return }
            Log.error("DictationController: \(mode) failed: \(type(of: error))")
            teardown()
            fail(error.localizedDescription)
        }
    }

    /// Runs a backend call with a valid token of the account `userId`; one retry with a forced
    /// refresh if the backend says the token is no longer valid. Throws `unauthorized` when that
    /// account is no longer the one signed in, so a dictation never continues under another account.
    static func withFreshToken<T>(account: AccountModel, userId: String?, _ call: (String) async throws -> T) async throws -> T {
        guard let token = try await account.validToken(), account.session?.userId == userId else {
            throw BackendError.unauthorized
        }
        do {
            return try await call(token)
        } catch BackendError.unauthorized {
            guard let fresh = try await account.validToken(forceRefresh: true), account.session?.userId == userId else {
                throw BackendError.unauthorized
            }
            return try await call(fresh)
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

    private func updateLevel(decibels: Float, generation: Int) {
        guard generation == self.generation else { return }
        switch phase {
        case .arming, .listening:
            // The device delivers digital silence while it starts; the waveform appears with the
            // first real signal.
            if !isHearing, decibels > DictationConfig.silenceDecibels { isHearing = true }
            guard isHearing else { return }
            let newLevel = envelope.level(forDecibels: decibels)
            let rate = newLevel > level ? DictationConfig.levelAttack : DictationConfig.levelRelease
            level += (newLevel - level) * rate
            peakMeterLevel = max(peakMeterLevel, level)
        case .idle, .transcribing, .running, .failed:
            return
        }
    }

    private func discard() {
        generation += 1
        transcriptionTask?.cancel()
        teardown()
        phase = .idle
    }

    private func teardown() {
        capture.stop()
        recorder = nil
        contextTask = nil
        revealTask?.cancel()
        revealTask = nil
        isHearing = false
        maxDurationTask?.cancel()
        maxDurationTask = nil
        transcriptionTask = nil
        startedAt = nil
        level = 0
    }

    /// Shown when the recording had no words in it. Kept to one line of the pill.
    static let nothingHeardMessage = "Didn't catch that. Try again."

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
