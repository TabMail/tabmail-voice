// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import AVFoundation
import os
import Testing
@testable import TabMailVoice

/// A microphone that records nothing, so no test touches audio hardware.
private final class SilentCapture: AudioCapturing {
    func prepare() {}
    func start(onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void, completion: @escaping @Sendable ((any Error)?) -> Void) {}
    func stop() {}
}

/// A microphone that records nothing and counts how often it was started.
private final class CountingCapture: AudioCapturing, @unchecked Sendable {
    private let count = OSAllocatedUnfairLock(initialState: 0)
    var starts: Int { count.withLock { $0 } }
    func prepare() {}
    func start(onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void, completion: @escaping @Sendable ((any Error)?) -> Void) {
        count.withLock { $0 += 1 }
    }
    func stop() {}
}

/// What the stub keystroke pasted, in order.
@MainActor
private final class Pastes {
    var texts: [String] = []
}

/// What a stub request saw of the controller, recorded while it ran.
@MainActor
private final class Seen {
    var states: [(phase: DictationController.Phase, mode: DictationMode)] = []
}

/// The app in front, as the controller sees it: a process id the test changes.
@MainActor
private final class FrontApp {
    var pid: pid_t? = 101
}

/// The keyboard input source's language, as the controller reads it: a value the test changes. Also
/// records what the controller showed as its language when each hold was revealed.
@MainActor
private final class Keyboard {
    var language: String?
    var atReveal: [String?] = []
}

/// The settings, as the controller reads them: values the test changes.
@MainActor
private final class Prefs {
    var value = DictationSettings(hasConsented: true, backendURL: URL(string: "https://api.example.com")!, readsScreen: true, emailApp: FakeThunderbird.app)
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
    private let pasteboard = NSPasteboard(name: NSPasteboard.Name("ai.tabmail.voice.tests.\(UUID().uuidString)"))
    private let front = FrontApp()
    private let keyboard = Keyboard()
    private let prefs = Prefs()

    private var cleanedStream: String { Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#) }

    /// A controller with both grants and the user's consent, signed in to `account`, on the stub backend.
    /// Thunderbird is not installed unless a test passes one.
    private func makeController(account: AccountModel? = nil, capture: any AudioCapturing = SilentCapture(), thunderbird: FakeThunderbird? = nil) -> (DictationController, Pastes) {
        let account = account ?? AccountModel(client: AuthClient(transport: auth.transport), store: InMemorySessionStore(Fixtures.session()))
        let pastes = Pastes()
        let pasteboard = self.pasteboard
        let inserter = TextInserter(pasteboard: pasteboard, restoreDelay: .zero, pasteKeystroke: {
            pastes.texts.append(pasteboard.string(forType: .string) ?? "")
        })
        let transcriptionTransport = transcription.transport
        let completionsTransport = completions.transport
        let thunderbird = thunderbird ?? {
            let absent = FakeThunderbird()
            absent.installed = false
            return absent
        }()
        let dictation = DictationController(
            permissions: PermissionsModel(readMicrophone: { .authorized }, readAccessibility: { true }),
            settings: { [prefs] in prefs.value },
            account: account,
            inserter: inserter,
            thunderbird: thunderbird.relay(),
            capture: capture,
            frontmostApp: { [front] in front.pid },
            keyboardLanguage: { [keyboard] in keyboard.language },
            makeTranscriptionClient: { TranscriptionClient(baseURL: $0, transport: transcriptionTransport) },
            makeCompletionsClient: { CompletionsClient(baseURL: $0, transport: completionsTransport) }
        )
        return (dictation, pastes)
    }

    /// Runs one recording through the controller; returns what was pasted.
    private func dictate(account: AccountModel? = nil) async -> (pasted: [String], controller: DictationController) {
        let (dictation, pastes) = makeController(account: account)
        await dictation.transcribe(WAVEncoder.encode(pcm16Mono: Data([0, 0, 1, 0]), sampleRate: 16_000), generation: 0)
        return (pastes.texts, dictation)
    }

    /// Holds the dictation key past the reveal delay (pressing Space once for agent mode), then
    /// releases it.
    private func holdAndRelease(_ controller: DictationController, mode: DictationMode = .dictation) async {
        controller.handle(.start)
        if mode == .agent { controller.handle(.toggleMode) }
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
    private func pendingRead(_ context: ScreenContext) -> (task: Task<ScreenContext, Never>, release: @Sendable () -> Void) {
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

    /// The `language` of each transcription request (nil: none sent).
    private var transcriptionLanguages: [String?] {
        transcription.requests.map { Fixtures.jsonBody(of: $0)["language"] as? String }
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

    /// The shared backend errors still explain the failure in the overlay, without a cleanup or paste.
    @Test(arguments: [
        (402, #"{"error":"no_active_subscription"}"#, "Dictation needs an active TabMail subscription."),
        (502, #"{"error":"transcription_failed"}"#, "Dictation failed. Please try again."),
        (200, #"{"unexpected":true}"#, "TabMail returned an unexpected response."),
    ])
    func aFailedTranscriptionIsNeitherCleanedUpNorPasted(status: Int, body: String, message: String) async {
        transcription.enqueue(status: status, text: body)

        let (pasted, controller) = await dictate()

        #expect(pasted.isEmpty)
        #expect(completions.requests.isEmpty)
        #expect(controller.phase == .failed(message))
    }

    /// Cancelled while the cleanup runs (another key pressed while the hotkey is held): the
    /// request is cancelled right away, not at the cleanup's timeout, and its result is not pasted.
    @Test func aDictationCancelledDuringTheCleanupPastesNothing() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: Fixtures.completionsStream(final: #"{"assistant":"Ask Jordan about the roadmap."}"#))
        // Its own task: cancelling the test's task would cancel the test.
        let dictation = Task { await dictate() }
        let cancelledAfter = OSAllocatedUnfairLock<Duration?>(initialState: nil)
        completions.gate = {
            let asked = ContinuousClock.now
            dictation.cancel()
            do { try await Task.sleep(for: .seconds(5)) } catch { cancelledAfter.withLock { $0 = ContinuousClock.now - asked } }
        }

        let (pasted, _) = await dictation.value

        #expect(completions.requests.count == 1)
        #expect(pasted.isEmpty)
        // Well inside `DictationConfig.cleanupTimeout`, whose timer would cancel it anyway.
        #expect((cancelledAfter.withLock { $0 } ?? .seconds(60)) < .seconds(1))
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

    /// A cleanup that never answers holds the paste only until the app's own cleanup timeout;
    /// then the transcript is pasted as heard.
    @Test func aCleanupThatNeverAnswersPastesTheTranscriptAtItsTimeout() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        completions.gate = { try? await Task.sleep(for: .seconds(60)) }
        let started = ContinuousClock.now

        let (pasted, controller) = await dictate()

        #expect(completions.requests.count == 1)
        #expect(pasted == [transcript])
        #expect(controller.phase == .idle)
        // The owner's cap on how long a cleanup may hold the paste is 3 seconds. It is written out
        // here rather than read from `DictationConfig`, so raising the setting past it fails.
        let ownersCap: TimeInterval = 3
        #expect(DictationConfig.cleanupTimeout <= ownersCap)
        // Slack for a loaded runner, far below the wait a stalled stream would otherwise cause.
        #expect(ContinuousClock.now - started < .seconds(ownersCap + 5))
    }

    /// A cleanup slower than the screen-read wait but within the app's own cleanup timeout is
    /// pasted: the controller gives the cleanup that timeout, not a shorter one.
    @Test func aCleanupThatAnswersWithinItsTimeoutIsPasted() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        completions.gate = { try? await Task.sleep(for: .seconds(DictationConfig.contextWait + 0.5)) }

        let (pasted, controller) = await dictate()

        #expect(completions.requests.count == 1)
        #expect(pasted == [cleaned])
        #expect(controller.phase == .idle)
    }

    // MARK: Key-down to paste

    /// Until the user consents in the welcome wizard, holding the key records nothing, reads no
    /// screen and sends nothing; it says why. Consent is asked at every key-down. The release
    /// comes before the hold counts, so "sends nothing" rests on nothing being recorded or read:
    /// the empty request and paste lists below would hold for a too-short hold too.
    @Test func withoutConsentNothingIsRecordedReadOrSent() async {
        prefs.value.hasConsented = false
        let capture = CountingCapture()
        let (controller, pastes) = makeController(capture: capture)
        var reads = 0
        controller.captureContext = {
            reads += 1
            return nil
        }

        controller.handle(.start)
        controller.handle(.finish)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(controller.phase == .failed("Finish setting up TabMail Voice from its menu to dictate."))
        #expect(capture.starts == 0)
        #expect(reads == 0)
        #expect(transcription.requests.isEmpty)
        #expect(completions.requests.isEmpty)
        #expect(pastes.texts.isEmpty)

        prefs.value.hasConsented = true
        controller.handle(.start)
        #expect(controller.phase == .arming)
        #expect(capture.starts == 1)
        #expect(reads == 1)
        controller.handle(.cancel)

        // Withdrawing consent later blocks the next dictation too: an earlier agreement doesn't outlive it.
        prefs.value.hasConsented = false
        controller.handle(.start)
        controller.handle(.finish)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(controller.phase == .failed("Finish setting up TabMail Voice from its menu to dictate."))
        #expect(capture.starts == 1)
        #expect(reads == 1)
        #expect(transcription.requests.isEmpty)
        #expect(completions.requests.isEmpty)
        #expect(pastes.texts.isEmpty)
    }

    /// The screen is read at key-down; a read done within `contextWait` of the transcript is sent
    /// with it to the cleanup.
    @Test func cleansUpWithTheScreenReadAtKeyDown() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        let (controller, pastes) = makeController(capture: ToneCapture())
        let read = pendingRead(screen("A"))
        let transcription = transcription
        var readStarted: [(phase: DictationController.Phase?, transcriptions: Int)] = []
        controller.captureContext = { [weak controller] in
            readStarted.append((controller?.phase, transcription.requests.count))
            return read.task
        }
        controller.contextWait = 30

        await holdAndRelease(controller)
        #expect(await eventually { transcription.requests.count == 1 })
        // Read once, at key-down: before the overlay is revealed and before anything is transcribed.
        #expect(readStarted.count == 1)
        #expect(readStarted.first?.phase == .arming)
        #expect(readStarted.first?.transcriptions == 0)
        // Longer than the default wait: using the default instead of the override loses this screen.
        try? await Task.sleep(for: .seconds(1))
        #expect(completions.requests.isEmpty)
        #expect(pastes.texts.isEmpty)
        read.release()

        #expect(await eventually { controller.phase == .idle && !pastes.texts.isEmpty })
        #expect(pastes.texts == [cleaned])
        #expect(cleanupVars(0)?["dictation"] as? String == transcript)
        #expect(cleanupVars(0)?["app_name"] as? String == "Example Notes A")
        #expect((cleanupVars(0)?["screen_text"] as? String)?.contains("Agenda A") == true)
    }

    /// The debug log file gets what was heard, what the cleanup made of it and what was pasted
    /// (ADR-DESK-015), after the backend clients' own entries.
    @Test func aDictationLogsItsTranscriptCleanedTextAndPaste() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)

        let entries = await ContentLogEntries.logged { _ = await dictate() }

        let steps = entries.all(excluding: ["Transcription ", "Completions "])
        #expect(steps.map(\.label) == ["Transcript (dictation)", "DictationCleanup: cleaned text", "TextInserter: pasting"])
        #expect(steps.map(\.text) == [transcript, cleaned, cleaned])
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
        controller.contextWait = 5

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

    /// The screen read is best effort: not done within the app's own `contextWait` of the
    /// transcript, the dictation is cleaned up without it rather than waiting.
    @Test func aScreenReadNotDoneInTimeIsLeftOut() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        let (controller, pastes) = makeController(capture: ToneCapture())
        let read = pendingRead(screen("A"))
        defer { read.release() }
        controller.captureContext = { read.task }
        let transcription = transcription

        await holdAndRelease(controller)
        #expect(await eventually { transcription.requests.count == 1 })
        let transcribed = ContinuousClock.now

        #expect(await eventually { controller.phase == .idle && !pastes.texts.isEmpty })
        // Slack for a loaded runner, far below a wait that would hold the paste for a slow app.
        #expect(ContinuousClock.now - transcribed < .seconds(DictationConfig.contextWait + 3))
        #expect(pastes.texts == [cleaned])
        #expect(completions.requests.count == 1)
        #expect(cleanupVars(0)?["dictation"] as? String == transcript)
        #expect(cleanupVars(0)?["app_name"] as? String == "")
        #expect(cleanupVars(0)?["screen_text"] as? String == "")
    }

    /// A screen read done shortly after the transcript, within the app's own `contextWait`, is
    /// still sent with it to the cleanup.
    @Test func aScreenReadDoneJustAfterTheTranscriptIsSent() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        let (controller, pastes) = makeController(capture: ToneCapture())
        let read = pendingRead(screen("A"))
        controller.captureContext = { read.task }
        // Released a fifth of the wait after the transcription is asked for; it answers at once.
        transcription.gate = {
            Task {
                try? await Task.sleep(for: .seconds(DictationConfig.contextWait / 5))
                read.release()
            }
        }

        await holdAndRelease(controller)

        #expect(await eventually { controller.phase == .idle && !pastes.texts.isEmpty })
        #expect(pastes.texts == [cleaned])
        #expect(completions.requests.count == 1)
        #expect(cleanupVars(0)?["app_name"] as? String == "Example Notes A")
    }

    // MARK: Agent mode (Space during the hold)

    private let request = "make this friendlier"

    /// A final event carrying `assistant`.
    private func reply(_ assistant: String) -> String {
        let json = String(decoding: try! JSONSerialization.data(withJSONObject: ["assistant": assistant]), as: UTF8.self)
        return Fixtures.completionsStream(final: json)
    }

    /// A screen whose focused field has `selected` selected.
    private func screen(selected: String) -> ScreenContext {
        var context = ScreenContext(appName: "Example Notes", windowTitle: "Weekly sync")
        context.textBeforeCaret = "Note: "
        context.selectedText = selected
        context.appendCaret()
        return context
    }

    /// One agent-mode request, spoken over `context`: the controller, what was pasted, and every phase
    /// it went through.
    /// `prepare` runs on the controller before the hold.
    private func carryOut(_ context: ScreenContext?, thunderbird: FakeThunderbird? = nil, prepare: (DictationController) -> Void = { _ in }) async -> (controller: DictationController, pastes: Pastes, phases: [DictationController.Phase]) {
        let (controller, pastes) = makeController(capture: ToneCapture(), thunderbird: thunderbird)
        var phases: [DictationController.Phase] = []
        controller.onPhaseChange = { phases.append($0) }
        controller.captureContext = { context.map { context in Task { context } } }
        prepare(controller)
        await holdAndRelease(controller, mode: .agent)
        #expect(await eventually {
            switch controller.phase {
            case .idle, .failed: true
            default: false
            }
        })
        return (controller, pastes, phases)
    }

    /// Without an email app there is nothing to choose: the selection's writing tool runs, with no
    /// agent call.
    @Test func agentModeEditsTheSelectionInPlace() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("Could we ship on Friday?"))

        let (controller, pastes, phases) = await carryOut(screen(selected: "Ship it Friday or else.\n"))

        // Pasted over the selection, keeping the selected line's line break; never the request itself.
        #expect(pastes.texts == ["Could we ship on Friday?\n"])
        #expect(controller.phase == .idle)
        #expect(controller.mode == .agent)
        #expect(controller.tools == [.edit])
        #expect(phases.contains(.running(.edit)))
        #expect(completions.requests.count == 1)
        #expect(cleanupVars(0)?["content"] as? String == "system_prompt_desktop_edit")
        #expect(cleanupVars(0)?["user_request"] as? String == request)
        #expect(cleanupVars(0)?["selected_text"] as? String == "Ship it Friday or else.\n")
    }

    /// Agent mode logs the request, the text its tool wrote (fitted to the selection) and the paste.
    @Test func agentModeLogsTheRequestTheWrittenTextAndThePaste() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("Could we ship on Friday?"))

        let entries = await ContentLogEntries.logged { _ = await carryOut(screen(selected: "Ship it Friday or else.\n")) }

        let steps = entries.all(excluding: ["Transcription ", "Completions "])
        #expect(steps.map(\.label) == ["Transcript (agent)", "DesktopAgent: edit wrote", "TextInserter: pasting"])
        #expect(steps.map(\.text) == [request, "Could we ship on Friday?\n", "Could we ship on Friday?\n"])
    }

    /// A mail request logs the chat message sent to Thunderbird, and no paste.
    @Test func aMailRequestLogsTheChatMessageSent() async {
        transcription.enqueue(status: 200, json: ["text": "find sam's invoice from last week"])
        completions.enqueue(status: 200, text: reply("thunderbird"))
        completions.enqueue(status: 200, text: reply("Find the invoice Sam sent last week."))

        let entries = await ContentLogEntries.logged { _ = await carryOut(screen(selected: ""), thunderbird: FakeThunderbird()) }

        let steps = entries.all(excluding: ["Transcription ", "Completions "])
        #expect(steps.map(\.label) == ["Transcript (agent)", "DesktopAgent: thunderbird wrote", "ThunderbirdRelay: sent"])
        #expect(steps.map(\.text) == ["find sam's invoice from last week", "Find the invoice Sam sent last week.", "Find the invoice Sam sent last week."])
    }

    @Test func agentModeComposesAtTheCaretWithNothingSelected() async {
        transcription.enqueue(status: 200, json: ["text": "write that we ship on Friday"])
        completions.enqueue(status: 200, text: reply("We ship on Friday."))

        var result: (controller: DictationController, pastes: Pastes, phases: [DictationController.Phase])?
        let entries = await ContentLogEntries.logged { result = await carryOut(screen(selected: "")) }
        guard let (controller, pastes, phases) = result else { return }

        #expect(pastes.texts == ["We ship on Friday."])
        // The debug log file gets the request, the text Compose wrote and the paste (ADR-DESK-015).
        let steps = entries.all(excluding: ["Transcription ", "Completions "])
        #expect(steps.map(\.label) == ["Transcript (agent)", "DesktopAgent: compose wrote", "TextInserter: pasting"])
        #expect(steps.map(\.text) == ["write that we ship on Friday", "We ship on Friday.", "We ship on Friday."])
        #expect(controller.tools == [.compose])
        #expect(phases.contains(.running(.compose)))
        #expect(cleanupVars(0)?["content"] as? String == "system_prompt_desktop_compose")
    }

    /// The selection alone decides between Edit and Compose, as the bubbles showed it: the agent only
    /// decides whether the request goes to the email app, and its pick of the other writing tool is
    /// overruled.
    @Test(arguments: [
        ("Ship it Friday or else.", "compose", AgentTool.edit, "system_prompt_desktop_edit"),
        ("", "edit", AgentTool.compose, "system_prompt_desktop_compose"),
    ])
    func theSelectionDecidesTheWritingTool(selected: String, agentChoice: String, tool: AgentTool, prompt: String) async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply(agentChoice))
        completions.enqueue(status: 200, text: reply("Could we ship on Friday?"))

        let (controller, pastes, phases) = await carryOut(screen(selected: selected), thunderbird: FakeThunderbird())

        #expect(controller.tools == [tool, .thunderbird])
        #expect(phases.contains(.running(tool)))
        #expect(!phases.contains(.running(tool == .edit ? .compose : .edit)))
        #expect(pastes.texts == ["Could we ship on Friday?"])
        #expect(cleanupVars(0)?["content"] as? String == "system_prompt_desktop_agent")
        #expect(cleanupVars(1)?["content"] as? String == prompt)
    }

    /// Whatever goes wrong, agent mode pastes nothing: the spoken request is not text for the document.
    @Test(arguments: [
        ([(200, "rewrite")], DesktopAgent.Failure.noTool.errorDescription!),
        ([(200, "compose"), (200, "")], DesktopAgent.Failure.noText.errorDescription!),
        ([(200, "compose"), (500, "")], BackendError.failed(status: 500).errorDescription!),
    ])
    func agentModePastesNothingWhenItCannotCarryOutTheRequest(replies: [(Int, String)], message: String) async {
        transcription.enqueue(status: 200, json: ["text": request])
        for (status, assistant) in replies {
            if status == 200 { completions.enqueue(status: 200, text: reply(assistant)) } else { completions.enqueue(status: status, json: ["error": "internal_error"]) }
        }
        let thunderbird = FakeThunderbird()

        let (controller, pastes, _) = await carryOut(screen(selected: ""), thunderbird: thunderbird)

        #expect(pastes.texts.isEmpty)
        #expect(thunderbird.pasted.isEmpty)
        #expect(controller.phase == .failed(message))
        #expect(completions.requests.count == replies.count)
    }

    /// A mail or calendar request is restated as a chat message and typed into TabMail's chat in
    /// Thunderbird; nothing is pasted where the user was.
    @Test func agentModeSendsMailRequestsToThunderbird() async {
        transcription.enqueue(status: 200, json: ["text": "find sam's invoice from last week"])
        completions.enqueue(status: 200, text: reply("thunderbird"))
        completions.enqueue(status: 200, text: reply("Find the invoice Sam sent last week."))
        let thunderbird = FakeThunderbird()

        let (controller, pastes, phases) = await carryOut(screen(selected: ""), thunderbird: thunderbird)

        #expect(controller.tools == [.compose, .thunderbird])
        #expect(controller.emailAppURL == URL(fileURLWithPath: "/Applications/Thunderbird.app"))
        #expect(thunderbird.pasted == ["Find the invoice Sam sent last week."])
        #expect(thunderbird.events.last == "return")
        #expect(pastes.texts.isEmpty)
        #expect(controller.phase == .idle)
        #expect(phases.contains(.running(.thunderbird)))
        #expect(cleanupVars(1)?["content"] as? String == "system_prompt_desktop_thunderbird")
        #expect(cleanupVars(1)?["user_request"] as? String == "find sam's invoice from last week")
    }

    /// Without Thunderbird its bubble isn't shown and the agent isn't asked: the request is written
    /// where the user is, and nothing is sent anywhere else.
    @Test func withoutThunderbirdItsToolIsNotOffered() async {
        transcription.enqueue(status: 200, json: ["text": "find sam's invoice"])
        completions.enqueue(status: 200, text: reply("Sam's invoice"))
        let thunderbird = FakeThunderbird()
        thunderbird.installed = false

        let (controller, pastes, _) = await carryOut(screen(selected: ""), thunderbird: thunderbird)

        #expect(controller.tools == [.compose])
        #expect(controller.emailAppURL == nil)
        #expect(controller.phase == .idle)
        #expect(completions.requests.count == 1)
        #expect(cleanupVars(0)?["content"] as? String == "system_prompt_desktop_compose")
        #expect(thunderbird.events.isEmpty)
        #expect(pastes.texts == ["Sam's invoice"])
    }

    @Test func aChatThatDoesNotOpenFailsTheRequest() async {
        transcription.enqueue(status: 200, json: ["text": "find sam's invoice"])
        completions.enqueue(status: 200, text: reply("thunderbird"))
        completions.enqueue(status: 200, text: reply("Find the invoice Sam sent."))
        let thunderbird = FakeThunderbird()
        thunderbird.shortcutOpensChat = false

        let (controller, pastes, _) = await carryOut(screen(selected: ""), thunderbird: thunderbird)

        #expect(controller.phase == .failed(ThunderbirdRelay.Failure.chatNotFocused.errorDescription!))
        #expect(thunderbird.pasted.isEmpty)
        #expect(pastes.texts.isEmpty)
    }

    /// Agent mode waits for the whole screen read, however long it takes, and offers no writing tool
    /// until it is done: the selection it carries decides between Edit and Compose.
    @Test func agentModeWaitsForTheWholeScreenRead() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("Could we ship on Friday?"))
        let (controller, pastes) = makeController(capture: ToneCapture())
        let read = pendingRead(screen(selected: "Ship it Friday or else."))
        controller.captureContext = { read.task }
        controller.contextWait = 0

        await holdAndRelease(controller, mode: .agent)
        #expect(await eventually { transcription.requests.count == 1 })
        try? await Task.sleep(for: .seconds(1))
        #expect(controller.tools.isEmpty)
        #expect(completions.requests.isEmpty)
        read.release()

        #expect(await eventually { controller.phase == .idle && !pastes.texts.isEmpty })
        #expect(controller.tools == [.edit])
        #expect(pastes.texts == ["Could we ship on Friday?"])
        #expect(cleanupVars(0)?["selected_text"] as? String == "Ship it Friday or else.")
    }

    /// Space switches the mode only while the key is held: back and forth, with the tools following.
    @Test func spaceTogglesAgentModeOnlyDuringTheHold() async {
        let (controller, _) = makeController(capture: ToneCapture(), thunderbird: FakeThunderbird())
        controller.captureContext = { Task { screen(selected: "") } }

        controller.handle(.toggleMode)
        #expect(controller.mode == .dictation)
        controller.handle(.start)
        #expect(await eventually { controller.phase == .listening })
        #expect(controller.tools.isEmpty)
        controller.handle(.toggleMode)
        #expect(controller.mode == .agent)
        #expect(controller.tools == [.compose, .thunderbird])
        controller.handle(.toggleMode)
        #expect(controller.mode == .dictation)
        #expect(controller.tools.isEmpty)
        #expect(controller.emailAppURL == nil)
        controller.handle(.cancel)
        controller.handle(.toggleMode)
        #expect(controller.mode == .dictation)
    }

    /// The user moved to another app while the text was written: it is not pasted there.
    @Test(arguments: [("Ship it Friday or else.", AgentTool.edit), ("", .compose)])
    func agentTextIsNotPastedIntoAnotherApp(selected: String, tool: AgentTool) async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("Could we ship on Friday?"))
        let front = front
        completions.gate = { await MainActor.run { front.pid = 202 } }

        let (controller, pastes, phases) = await carryOut(screen(selected: selected))

        #expect(phases.contains(.running(tool)))
        #expect(completions.requests.count == 1)
        #expect(pastes.texts.isEmpty)
        #expect(controller.phase == .failed(DesktopAgent.Failure.appChanged.errorDescription!))
    }

    /// The app that counts is the one in front at key-down: a switch made while the request is still
    /// being transcribed is caught too.
    @Test func agentTextIsNotPastedAfterASwitchDuringTheTranscription() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("We ship on Friday."))
        let front = front
        transcription.gate = { await MainActor.run { front.pid = 202 } }

        let (controller, pastes, phases) = await carryOut(screen(selected: ""))

        #expect(phases.contains(.running(.compose)))
        #expect(pastes.texts.isEmpty)
        #expect(controller.phase == .failed(DesktopAgent.Failure.appChanged.errorDescription!))
    }

    /// The app that counts is the one in front at key-down, not at release: a switch made while the
    /// key is still held is caught too.
    @Test func agentTextIsNotPastedAfterASwitchDuringTheHold() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("We ship on Friday."))
        let (controller, pastes) = makeController(capture: ToneCapture())
        controller.captureContext = { Task { screen(selected: "") } }

        controller.handle(.start)
        controller.handle(.toggleMode)
        #expect(await eventually { controller.phase == .listening })
        front.pid = 202
        controller.handle(.finish)

        #expect(await eventually { controller.phase == .failed(DesktopAgent.Failure.appChanged.errorDescription!) })
        #expect(completions.requests.count == 1)
        #expect(pastes.texts.isEmpty)
    }

    /// Each hold counts the app in front at its own key-down: after one request done in one app, the
    /// next, made in another, is pasted there.
    @Test func eachHoldTakesTheAppInFrontAtItsKeyDown() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("We ship on Friday."))
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("We ship on Monday."))
        let (controller, pastes, _) = await carryOut(screen(selected: ""))
        #expect(pastes.texts == ["We ship on Friday."])

        front.pid = 202
        await holdAndRelease(controller, mode: .agent)

        #expect(await eventually { pastes.texts.count == 2 || controller.phase == .failed(DesktopAgent.Failure.appChanged.errorDescription!) })
        #expect(pastes.texts == ["We ship on Friday.", "We ship on Monday."])
    }

    /// Settings are read once, as a hold starts: changing the server, the email app and screen reading
    /// while it runs changes nothing for it, and the change applies from the next hold.
    @Test func settingsChangedDuringAHoldApplyFromTheNextOne() async {
        let thunderbird = FakeThunderbird()
        let reads = Counter()
        transcription.enqueue(status: 200, json: ["text": "find sam's invoice"])
        completions.enqueue(status: 200, text: reply("thunderbird"))
        completions.enqueue(status: 200, text: reply("Find the invoice Sam sent."))
        let prefs = prefs

        let (controller, _, _) = await carryOut(screen(selected: ""), thunderbird: thunderbird) { controller in
            controller.onPhaseChange = { phase in
                guard phase == .listening else { return }
                prefs.value = DictationSettings(hasConsented: true, backendURL: URL(string: "https://dev.example.com")!, readsScreen: false, emailApp: "org.example.othermail")
            }
            let read = controller.captureContext
            controller.captureContext = {
                reads.count += 1
                return read?()
            }
        }

        #expect(thunderbird.pasted == ["Find the invoice Sam sent."])
        #expect(thunderbird.apps == [FakeThunderbird.app])
        #expect(Set((transcription.requests + completions.requests).map(\.url?.host)) == ["api.example.com"])
        #expect(reads.count == 1)

        controller.onPhaseChange = nil
        transcription.enqueue(status: 200, json: ["text": "find sam's receipt"])
        completions.enqueue(status: 200, text: reply("thunderbird"))
        completions.enqueue(status: 200, text: reply("Find the receipt Sam sent."))
        await holdAndRelease(controller, mode: .agent)

        #expect(await eventually { thunderbird.pasted.count == 2 })
        #expect(thunderbird.apps == [FakeThunderbird.app, "org.example.othermail"])
        #expect((transcription.requests + completions.requests).map(\.url?.host).filter { $0 == "dev.example.com" }.count == 3)
        #expect(reads.count == 1)
    }

    /// A hold is transcribed in the keyboard's language at its key-down, which the overlay shows from the
    /// reveal on: switching the keyboard while the hold listens or while its recording uploads changes
    /// neither, and the next hold takes the new keyboard's.
    @Test func eachHoldIsTranscribedInTheKeyboardLanguageAtItsKeyDown() async {
        let keyboard = keyboard
        keyboard.language = "ko"
        let (controller, pastes) = makeController(capture: ToneCapture())
        controller.onPhaseChange = { [weak controller] phase in
            guard phase == .listening else { return }
            keyboard.atReveal.append(controller?.language)
            keyboard.language = keyboard.language == "ko" ? "en" : "ko"
        }
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        transcription.gate = {
            await MainActor.run { keyboard.language = "ja" }
        }

        await holdAndRelease(controller)
        #expect(await eventually { controller.phase == .idle && pastes.texts.count == 1 })
        #expect(keyboard.atReveal == ["ko"])
        #expect(controller.language == "ko")
        #expect(transcriptionLanguages == ["ko"])

        transcription.gate = nil
        transcription.enqueue(status: 200, json: ["text": "next dictated words"])
        completions.enqueue(status: 200, text: reply("Next dictated words."))
        await holdAndRelease(controller)
        #expect(await eventually { controller.phase == .idle && pastes.texts.count == 2 })
        #expect(keyboard.atReveal == ["ko", "ja"])
        #expect(transcriptionLanguages == ["ko", "ja"])
    }

    /// A keyboard with no language of its own sends none: the backend's default model transcribes it.
    @Test func aKeyboardWithoutALanguageSendsNone() async {
        keyboard.language = nil
        let (controller, pastes) = makeController(capture: ToneCapture())
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)

        await holdAndRelease(controller)
        #expect(await eventually { controller.phase == .idle && pastes.texts.count == 1 })
        #expect(controller.language == nil)
        #expect(transcription.requests.count == 1)
        guard transcription.requests.count == 1 else { return }
        #expect(Fixtures.jsonBody(of: transcription.requests[0])["language"] == nil)
    }

    /// Both requests of one ordinary dictation use its key-down server; the next hold uses the new server.
    @Test func anOrdinaryDictationKeepsItsServerUntilTheNextHold() async {
        let prefs = prefs
        let (controller, pastes) = makeController(capture: ToneCapture())
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        transcription.gate = {
            await MainActor.run {
                prefs.value.backendURL = URL(string: "https://dev.example.com")!
            }
        }

        await holdAndRelease(controller)
        #expect(await eventually { controller.phase == .idle && pastes.texts.count == 1 })
        #expect(pastes.texts == [cleaned])
        #expect(transcription.requests.map(\.url?.host) == ["api.example.com"])
        #expect(completions.requests.map(\.url?.host) == ["api.example.com"])
        #expect(cleanupVars(0)?["dictation"] as? String == transcript)

        transcription.gate = nil
        transcription.enqueue(status: 200, json: ["text": "next dictated words"])
        completions.enqueue(status: 200, text: reply("Next dictated words."))
        await holdAndRelease(controller)
        #expect(await eventually { controller.phase == .idle && pastes.texts.count == 2 })
        #expect(pastes.texts == [cleaned, "Next dictated words."])
        #expect(transcription.requests.map(\.url?.host) == ["api.example.com", "dev.example.com"])
        #expect(completions.requests.map(\.url?.host) == ["api.example.com", "dev.example.com"])
        #expect(cleanupVars(1)?["dictation"] as? String == "next dictated words")
    }

    /// Space offers the email app Settings named at key-down, not the one it names by the time Space
    /// is pressed: the bubble shown is the app the request would go to.
    @Test(arguments: [(FakeThunderbird.app as String?, nil as String?), (nil, FakeThunderbird.app)])
    func spaceOffersTheEmailAppOfTheHoldsKeyDown(atKeyDown: String?, changedTo: String?) async {
        prefs.value.emailApp = atKeyDown
        let (controller, _) = makeController(capture: ToneCapture(), thunderbird: FakeThunderbird())
        let context = screen(selected: "")
        controller.captureContext = { Task { context } }

        controller.handle(.start)
        #expect(await eventually { controller.phase == .listening })
        prefs.value.emailApp = changedTo
        controller.handle(.toggleMode)

        let offered: [AgentTool] = atKeyDown == nil ? [.compose] : [.compose, .thunderbird]
        #expect(await eventually { controller.tools == offered })
        #expect(controller.emailAppURL == atKeyDown.map { _ in URL(fileURLWithPath: "/Applications/Thunderbird.app") })
        controller.handle(.cancel)
        #expect(await eventually { controller.phase == .idle })
    }

    /// Thunderbird comes to the front to take the chat message: that is no reason to drop it.
    @Test func aMailRequestIsSentWhateverAppIsInFront() async {
        transcription.enqueue(status: 200, json: ["text": "find sam's invoice"])
        completions.enqueue(status: 200, text: reply("thunderbird"))
        completions.enqueue(status: 200, text: reply("Find the invoice Sam sent."))
        let front = front
        completions.gate = { await MainActor.run { front.pid = 202 } }
        let thunderbird = FakeThunderbird()

        let (controller, pastes, _) = await carryOut(screen(selected: ""), thunderbird: thunderbird)

        #expect(thunderbird.pasted == ["Find the invoice Sam sent."])
        #expect(pastes.texts.isEmpty)
        #expect(controller.phase == .idle)
    }

    /// While a request runs, the hotkey neither starts another dictation nor switches its mode:
    /// the request carries on and its text is pasted.
    @Test func aRunningRequestIgnoresTheHotkey() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("We ship on Friday."))
        let seen = Seen()

        let (controller, pastes, _) = await carryOut(screen(selected: "")) { controller in
            completions.gate = {
                await MainActor.run {
                    controller.handle(.start)
                    controller.handle(.toggleMode)
                    seen.states.append((controller.phase, controller.mode))
                }
            }
        }

        #expect(seen.states.count == 1)
        guard seen.states.count == 1 else { return }
        #expect(seen.states[0].phase == .running(.compose))
        #expect(seen.states[0].mode == .agent)
        #expect(pastes.texts == ["We ship on Friday."])
        #expect(controller.phase == .idle)
    }

    /// Cancelled while the tool writes: nothing is pasted, then or when the text arrives.
    @Test func aRequestCancelledWhileRunningPastesNothing() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("We ship on Friday."))
        let seen = Seen()

        let (controller, pastes, _) = await carryOut(screen(selected: "")) { controller in
            completions.gate = {
                await MainActor.run {
                    seen.states.append((controller.phase, controller.mode))
                    controller.handle(.cancel)
                }
            }
        }
        // The reply still arrives after the cancel.
        try? await Task.sleep(for: .milliseconds(300))

        #expect(seen.states.map(\.phase) == [.running(.compose)])
        #expect(completions.requests.count == 1)
        #expect(pastes.texts.isEmpty)
        #expect(controller.phase == .idle)
    }

    /// Space switches nothing once the hold is over: not while transcribing, nor after a failure.
    @Test func spaceSwitchesNothingAfterTheHold() async {
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        transcription.enqueue(status: 200, json: ["text": "  "])
        let (controller, pastes) = makeController(capture: ToneCapture(), thunderbird: FakeThunderbird())
        controller.captureContext = { Task { screen(selected: "") } }
        let seen = Seen()
        transcription.gate = {
            await MainActor.run {
                controller.handle(.toggleMode)
                seen.states.append((controller.phase, controller.mode))
            }
        }

        await holdAndRelease(controller)
        #expect(await eventually { controller.phase == .idle && !pastes.texts.isEmpty })
        #expect(seen.states.count == 1)
        #expect(seen.states.first?.phase == .transcribing)
        #expect(seen.states.first?.mode == .dictation)
        #expect(pastes.texts == [cleaned])
        #expect(cleanupVars(0)?["content"] as? String == DictationConfig.cleanupPrompt)

        transcription.gate = nil
        await holdAndRelease(controller)
        #expect(await eventually { controller.phase == .failed(DictationController.nothingHeardMessage) })
        controller.handle(.toggleMode)
        #expect(controller.mode == .dictation)
        #expect(controller.tools.isEmpty)
        #expect(controller.emailAppURL == nil)
    }

    /// A cancelled hold's screen read that finishes during the next hold does not change the tools
    /// that hold offers: its selection is of a screen the user has left.
    @Test func aSupersededScreenReadLeavesTheToolsAlone() async {
        let (controller, _) = makeController(capture: ToneCapture())
        let first = pendingRead(screen(selected: "Ship it Friday or else."))
        controller.captureContext = { first.task }
        controller.handle(.start)
        controller.handle(.toggleMode)
        #expect(controller.tools.isEmpty)
        controller.handle(.cancel)

        controller.captureContext = { Task { screen(selected: "") } }
        controller.handle(.start)
        controller.handle(.toggleMode)
        #expect(await eventually { controller.tools == [.compose] })
        first.release()
        try? await Task.sleep(for: .milliseconds(200))

        #expect(controller.tools == [.compose])
        controller.handle(.cancel)
    }

    /// A dictation after agent mode is a dictation again: cleaned up and pasted.
    @Test func aHoldAfterAgentModeDictatesAgain() async {
        transcription.enqueue(status: 200, json: ["text": request])
        completions.enqueue(status: 200, text: reply("We ship on Friday."))
        transcription.enqueue(status: 200, json: ["text": transcript])
        completions.enqueue(status: 200, text: cleanedStream)
        let (controller, pastes, _) = await carryOut(nil)

        await holdAndRelease(controller)
        #expect(await eventually { pastes.texts.count == 2 })

        #expect(controller.mode == .dictation)
        #expect(controller.tools.isEmpty)
        #expect(pastes.texts == ["We ship on Friday.", cleaned])
        #expect(cleanupVars(1)?["content"] as? String == DictationConfig.cleanupPrompt)
    }
}

/// Fixed permission snapshots must preserve denied and undecided grants as well as granted ones.
@MainActor
struct PermissionsModelTests {
    @Test(arguments: [
        (AVAuthorizationStatus.notDetermined, false),
        (.restricted, true),
        (.denied, false),
        (.authorized, false),
        (.authorized, true),
    ])
    func startsWithTheStatesReadFromTheSystem(microphone: AVAuthorizationStatus, accessibilityTrusted: Bool) {
        let permissions = PermissionsModel(readMicrophone: { microphone }, readAccessibility: { accessibilityTrusted })

        #expect(permissions.microphone == microphone)
        #expect(permissions.accessibilityTrusted == accessibilityTrusted)
    }

    /// A grant made in the welcome wizard (or System Settings) is announced once, when the model
    /// already reports it, so the microphone can be prepared and the hotkey re-installed.
    @Test func announcesEachGrantOnceWhenItLands() {
        var microphone = AVAuthorizationStatus.notDetermined
        var trusted = false
        let permissions = PermissionsModel(readMicrophone: { microphone }, readAccessibility: { trusted })
        var microphoneGrants: [AVAuthorizationStatus] = []
        var accessibilityGrants = 0
        permissions.onMicrophoneGranted = { [unowned permissions] in microphoneGrants.append(permissions.microphone) }
        permissions.onAccessibilityGranted = { accessibilityGrants += 1 }

        permissions.refresh()
        #expect(microphoneGrants.isEmpty)
        #expect(accessibilityGrants == 0)

        microphone = .authorized
        permissions.refresh()
        #expect(microphoneGrants == [.authorized])
        #expect(accessibilityGrants == 0)

        trusted = true
        permissions.refresh()
        permissions.refresh()
        #expect(microphoneGrants == [.authorized])
        #expect(accessibilityGrants == 1)
        #expect(permissions.allGranted)

        // Revoked and granted again: announced again.
        microphone = .denied
        permissions.refresh()
        microphone = .authorized
        permissions.refresh()
        #expect(microphoneGrants == [.authorized, .authorized])
    }
}
