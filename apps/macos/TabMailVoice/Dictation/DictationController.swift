// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import AVFoundation
import Observation

/// Drives one push-to-talk dictation at a time: record → transcribe on the backend → clean up the
/// transcript with the screen context → paste. In agent mode (Space pressed during the hold) the
/// transcript is a request instead: the selection picks Edit or Compose, the agent may send it to
/// TabMail's chat in Thunderbird instead, and the tool's text is pasted, or sent there.
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
    /// The tools agent mode offers this time (`DesktopAgent.tools(for:emailAppAvailable:)`). Empty in
    /// dictation mode, and until the screen read at key-down is done: its selection decides between
    /// Edit and Compose.
    private(set) var tools: [AgentTool] = []
    /// That email app's bundle, whose icon the Thunderbird bubble shows.
    private(set) var emailAppURL: URL?
    private(set) var level: Float = 0
    @ObservationIgnored private var envelope = LevelEnvelope()
    /// Debug tuning aid: the highest waveform level reached this dictation.
    @ObservationIgnored private var peakMeterLevel: Float = 0
    /// True once the microphone delivers audio; until then the overlay shows its warm-up swirl.
    private(set) var isHearing = false
    /// The language this dictation is transcribed in: the keyboard's at key-down, read once so the
    /// overlay's badge and the request always agree (ADR-DESK-019). Nil: none sent, no badge.
    private(set) var language: String?

    @ObservationIgnored var onPhaseChange: ((Phase) -> Void)?
    /// Starts reading the screen context when a dictation starts (key-down) with screen reading on,
    /// with the target app still frontmost. Nil result: no context (the cleanup runs without it).
    @ObservationIgnored var captureContext: (() -> Task<ScreenContext, Never>?)?
    /// How long the cleanup waits for that read once the transcript is ready (agent mode waits for
    /// all of it). Internal for tests.
    @ObservationIgnored var contextWait = DictationConfig.contextWait

    @ObservationIgnored private let permissions: PermissionsModel
    /// Reads the settings, once per dictation.
    @ObservationIgnored private let readSettings: @MainActor () -> DictationSettings
    @ObservationIgnored private let account: AccountModel
    @ObservationIgnored private let makeTranscriptionClient: @MainActor (URL) -> TranscriptionClient
    @ObservationIgnored private let makeCompletionsClient: @MainActor (URL) -> CompletionsClient
    @ObservationIgnored private let inserter: TextInserter
    @ObservationIgnored private let thunderbird: ThunderbirdRelay
    @ObservationIgnored private let capture: any AudioCapturing
    /// The process of the app in front.
    @ObservationIgnored private let frontmostApp: @MainActor () -> pid_t?
    /// The active keyboard input source's language (`KeyboardLanguage`).
    @ObservationIgnored private let keyboardLanguage: @MainActor () -> String?
    @ObservationIgnored private let clock = ContinuousClock()

    // Per-dictation state. `generation` invalidates callbacks from a superseded dictation.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var startedAt: ContinuousClock.Instant?
    /// The settings this dictation started with; it reads no others.
    @ObservationIgnored private var settings: DictationSettings
    /// The app in front at key-down, where agent mode's text belongs.
    @ObservationIgnored private var targetApp: pid_t?
    @ObservationIgnored private var recorder: AudioRecorder?
    @ObservationIgnored private var contextTask: Task<ScreenContext, Never>?
    /// That read's result, once done (nil without a read); `tools` waits for it.
    @ObservationIgnored private var screenRead: ScreenContext?
    @ObservationIgnored private var isScreenReadDone = false
    @ObservationIgnored private var revealTask: Task<Void, Never>?
    @ObservationIgnored private var maxDurationTask: Task<Void, Never>?
    @ObservationIgnored private var transcriptionTask: Task<Void, Never>?
    @ObservationIgnored private var failureResetTask: Task<Void, Never>?

    init(
        permissions: PermissionsModel,
        settings: @escaping @MainActor () -> DictationSettings,
        account: AccountModel,
        inserter: TextInserter = TextInserter(),
        thunderbird: ThunderbirdRelay,
        capture: any AudioCapturing = MicrophoneCapture(),
        frontmostApp: @escaping @MainActor () -> pid_t? = { NSWorkspace.shared.frontmostApplication?.processIdentifier },
        keyboardLanguage: @escaping @MainActor () -> String? = { KeyboardLanguage.current() },
        makeTranscriptionClient: @escaping @MainActor (URL) -> TranscriptionClient,
        makeCompletionsClient: @escaping @MainActor (URL) -> CompletionsClient
    ) {
        self.permissions = permissions
        self.readSettings = settings
        self.settings = settings()
        self.account = account
        self.inserter = inserter
        self.thunderbird = thunderbird
        self.capture = capture
        self.frontmostApp = frontmostApp
        self.keyboardLanguage = keyboardLanguage
        self.makeTranscriptionClient = makeTranscriptionClient
        self.makeCompletionsClient = makeCompletionsClient
    }

    func handle(_ action: PushToTalkGesture.Action) {
        switch action {
        case .start: start()
        case .finish: finish()
        case .cancel: cancel()
        case .toggleMode: toggleMode()
        }
    }

    /// Does the slow, microphone-off part of starting the microphone ahead of the first dictation.
    func prewarm() {
        guard permissions.microphone == .authorized else { return }
        capture.prepare()
    }

    /// Menu-driven toggle, for users who prefer clicking to holding a key.
    func toggle() {
        if phase == .listening { finish() } else { start() }
    }

    /// Starts a dictation; `toggleMode()` makes it an agent request.
    func start() {
        switch phase {
        case .idle, .failed: break
        case .arming, .listening, .transcribing, .running: return
        }
        // First, before anything else: the settings this dictation uses, whatever changes meanwhile.
        settings = readSettings()
        guard settings.hasConsented else {
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
        mode = .dictation
        emailAppURL = nil
        screenRead = nil
        isScreenReadDone = false
        tools = []
        level = 0
        peakMeterLevel = 0
        envelope = LevelEnvelope()
        isHearing = false
        startedAt = clock.now
        targetApp = frontmostApp()
        language = keyboardLanguage()
        phase = .arming
        contextTask = settings.readsScreen ? captureContext?() : nil
        if let read = contextTask {
            Task { [weak self] in
                let context = await read.value
                guard let self, self.generation == current else { return }
                self.screenRead = context
                self.isScreenReadDone = true
                self.updateTools()
            }
        } else {
            isScreenReadDone = true
        }

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
        Log.debug("DictationController: arming (generation \(current), language \(language ?? "none"))")
    }

    /// Space during the hold: switches between dictation and agent mode.
    func toggleMode() {
        switch phase {
        case .arming, .listening: break
        case .idle, .transcribing, .running, .failed: return
        }
        mode = mode.toggled
        emailAppURL = mode == .agent ? thunderbird.applicationURL(for: settings.emailApp) : nil
        updateTools()
        Log.debug("DictationController: switched to \(mode)")
    }

    private func updateTools() {
        tools = mode == .agent && isScreenReadDone ? DesktopAgent.tools(for: screenRead, emailAppAvailable: emailAppURL != nil) : []
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
        let settings = settings
        let language = language
        do {
            let client = makeTranscriptionClient(settings.backendURL)
            let transcript = try await Self.withFreshToken(account: account, userId: userId) { try await client.transcribe(wav: wav, language: language, accessToken: $0) }
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard generation == current, !Task.isCancelled else { return }
            Log.debug("DictationController: transcript ready (\(transcript.count) chars)")
            Log.content("Transcript (\(mode))", transcript)
            guard !transcript.isEmpty else {
                teardown()
                fail(Self.nothingHeardMessage)
                return
            }
            let read = contextTask
            let context: ScreenContext?
            switch mode {
            case .dictation:
                // The screen context read at key-down, if it is done in time: best effort (ADR-DESK-008).
                context = try? await withTimeout(seconds: contextWait) { await read?.value }
                if read != nil, context == nil { Log.debug("DictationController: screen read not done in time; continuing without it") }
            case .agent:
                // All of it: its selection decides between Edit and Compose, as the bubbles showed.
                context = await read?.value
            }
            guard generation == current, !Task.isCancelled else { return }
            switch mode {
            case .dictation:
                let text = await DictationCleanup.cleanUp(transcript, context: context, client: makeCompletionsClient(settings.backendURL), account: account, userId: userId)
                guard generation == current, !Task.isCancelled else { return }
                await inserter.insert(text)
            case .agent:
                let client = makeCompletionsClient(settings.backendURL)
                let tool = try await DesktopAgent.tool(for: transcript, context: context, emailAppAvailable: emailAppURL != nil, client: client, account: account, userId: userId)
                guard generation == current, !Task.isCancelled else { return }
                Log.debug("DictationController: agent chose \(tool.rawValue)")
                phase = .running(tool)
                let text = try await DesktopAgent.write(tool, for: transcript, context: context, client: client, account: account, userId: userId)
                guard generation == current, !Task.isCancelled else { return }
                switch tool {
                case .edit, .compose:
                    // The request may have taken long enough for the user to move on: the text
                    // belongs in the app they spoke over, and is pasted nowhere else.
                    guard frontmostApp() == targetApp else { throw DesktopAgent.Failure.appChanged }
                    // An edit pastes over the selection; a compose runs only with nothing selected.
                    await inserter.insert(text)
                case .thunderbird:
                    try await thunderbird.send(text, to: settings.emailApp)
                }
            }
            guard generation == current else { return }
            teardown()
            phase = .idle
        } catch {
            guard generation == current, !Task.isCancelled else { return }
            Log.error("DictationController: \(mode) failed: \(Self.describe(error))")
            teardown()
            fail(error.localizedDescription)
        }
    }

    /// An error for the log: the case of this app's own errors (they carry no user content), else the
    /// type (and a URL error's code).
    static func describe(_ error: any Error) -> String {
        switch error {
        case let failure as DesktopAgent.Failure: "DesktopAgent.Failure.\(failure)"
        case let failure as ThunderbirdRelay.Failure: "ThunderbirdRelay.Failure.\(failure)"
        case let failure as BackendError: "BackendError.\(failure)"
        case let failure as URLError: "URLError \(failure.code.rawValue)"
        default: "\(type(of: error))"
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
