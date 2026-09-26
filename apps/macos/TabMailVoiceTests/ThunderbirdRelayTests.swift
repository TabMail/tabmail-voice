// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

/// A pretend Thunderbird for `ThunderbirdRelay`: no app is launched, no keystroke posted. Records what
/// the relay did to it, in order.
@MainActor
final class FakeThunderbird {
    var installed = true
    var running = true
    var hasWindow = true
    var frontmost = false
    /// Whether asking Thunderbird to the front works.
    var comesToFront = true
    var focusedTitle: String? = "Inbox - Thunderbird"
    /// Whether the open-chat shortcut opens the chat.
    var shortcutOpensChat = true
    /// Whether launching shows a window.
    var launchShowsWindow = true
    /// How many checks find no window, then Thunderbird not in front, before they do: a slow launch
    /// or activation.
    var windowLag = 0
    var frontLag = 0
    /// Runs when the shortcut is posted, after the chat (if it opens) has focus.
    var onOpenChat: (@MainActor (FakeThunderbird) -> Void)?
    /// Whether the user switches away as the message is pasted.
    var loseFocusOnPaste = false
    /// Runs during the `n`th read of the focused window's title (from 1), before it answers.
    var onTitleRead: (@MainActor (FakeThunderbird, Int) -> Void)?
    private var titleReads = 0
    private(set) var events: [String] = []
    /// Every app the relay asked about, in order, without repeats.
    private(set) var apps: [String] = []
    private(set) var pasted: [String] = []

    nonisolated static let chatTitle = "TabMail Chat"
    nonisolated static let app = "org.example.mail"

    private func asked(_ app: String) {
        if apps.last != app { apps.append(app) }
    }

    /// A relay on this Thunderbird, with waits short enough for tests.
    func relay(chatInputSettle: TimeInterval = 0, chatTimeout: TimeInterval = 0.2) -> ThunderbirdRelay {
        let relay = ThunderbirdRelay(system: ThunderbirdRelay.System(
            applicationURL: { [self] app in
                asked(app)
                return installed ? URL(fileURLWithPath: "/Applications/Thunderbird.app") : nil
            },
            isRunning: { [self] app in
                asked(app)
                return running
            },
            launch: { [self] _ in
                events.append("launch")
                running = true
                hasWindow = launchShowsWindow
                frontmost = launchShowsWindow
            },
            hasWindow: { [self] app in
                asked(app)
                guard windowLag == 0 else {
                    windowLag -= 1
                    return false
                }
                return hasWindow
            },
            activate: { [self] app in
                asked(app)
                events.append("activate")
                if comesToFront { frontmost = true }
            },
            isFrontmost: { [self] app in
                asked(app)
                guard frontLag == 0 else {
                    frontLag -= 1
                    return false
                }
                return frontmost
            },
            focusedWindowTitle: { [self] app in
                asked(app)
                titleReads += 1
                onTitleRead?(self, titleReads)
                // Answers after a turn, as an Accessibility call off the main thread does.
                await Task.yield()
                return focusedTitle
            },
            openChat: { [self] in
                events.append("openChat")
                if shortcutOpensChat { focusedTitle = Self.chatTitle }
                onOpenChat?(self)
            },
            paste: { [self] text in
                events.append("paste")
                pasted.append(text)
                if loseFocusOnPaste { frontmost = false }
            },
            pressReturn: { [self] in events.append("return") }
        ))
        relay.launchTimeout = 0.2
        relay.addonSettle = 0
        relay.activateTimeout = 0.2
        relay.chatTimeout = chatTimeout
        relay.chatInputSettle = chatInputSettle
        relay.pollInterval = 0.01
        return relay
    }
}

/// `ThunderbirdRelay` against a pretend Thunderbird. The invariant: the message is pasted, and
/// Return pressed, only while TabMail's chat window in Thunderbird has focus; the open-chat shortcut
/// is posted only while Thunderbird is in front.
@MainActor
struct ThunderbirdRelayTests {
    private let message = "Find the invoice Sam sent last week."

    /// Every step is about the email app the send was given, the dictation's.
    @Test func sendsIntoAnOpenChatWithoutTheShortcut() async throws {
        let thunderbird = FakeThunderbird()
        thunderbird.focusedTitle = FakeThunderbird.chatTitle

        try await thunderbird.relay().send(message, to: FakeThunderbird.app)

        #expect(thunderbird.events == ["activate", "paste", "return"])
        #expect(thunderbird.pasted == [message])
        #expect(thunderbird.apps == [FakeThunderbird.app])
    }

    @Test func opensTheChatWithTheShortcut() async throws {
        let thunderbird = FakeThunderbird()

        try await thunderbird.relay().send(message, to: FakeThunderbird.app)

        #expect(thunderbird.events == ["activate", "openChat", "paste", "return"])
        #expect(thunderbird.pasted == [message])
    }

    /// A window that only mentions the chat is not it: a draft replying to a message about it, or
    /// the main window showing a message whose subject starts with its name, would otherwise get the
    /// message pasted in, and Return pressed. On macOS Thunderbird titles the chat's popup window
    /// with the page title alone.
    @Test(arguments: [
        "Write: Re: TabMail Chat feedback - Thunderbird",
        "TabMail Chat feedback - Mozilla Thunderbird",
        "TabMail Chat - support thread",
        "TabMail Chat — Mozilla Thunderbird",
        "Re: TabMail Chat",
    ])
    func aWindowThatOnlyMentionsTheChatGetsNothing(title: String) async {
        let thunderbird = FakeThunderbird()
        thunderbird.focusedTitle = title
        thunderbird.shortcutOpensChat = false

        await #expect(throws: ThunderbirdRelay.Failure.chatNotFocused) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["activate", "openChat"])
        #expect(thunderbird.pasted.isEmpty)
    }

    /// A window whose title can't be read (none has focus, Thunderbird is hung, or it quit) is not
    /// the chat.
    @Test func aWindowWithNoReadableTitleGetsNothing() async {
        let thunderbird = FakeThunderbird()
        thunderbird.focusedTitle = nil
        thunderbird.shortcutOpensChat = false

        await #expect(throws: ThunderbirdRelay.Failure.chatNotFocused) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["activate", "openChat"])
        #expect(thunderbird.pasted.isEmpty)
    }

    @Test func launchesThunderbirdWhenItIsNotRunning() async throws {
        let thunderbird = FakeThunderbird()
        thunderbird.running = false
        thunderbird.hasWindow = false

        try await thunderbird.relay().send(message, to: FakeThunderbird.app)

        #expect(thunderbird.events == ["launch", "activate", "openChat", "paste", "return"])
    }

    @Test func aThunderbirdThatShowsNoWindowFails() async {
        let thunderbird = FakeThunderbird()
        thunderbird.running = false
        thunderbird.hasWindow = false
        thunderbird.launchShowsWindow = false

        await #expect(throws: ThunderbirdRelay.Failure.didNotLaunch) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["launch"])
    }

    /// No email app set up, or one that isn't installed: nothing happens.
    @Test(arguments: [nil, FakeThunderbird.app])
    func withoutThunderbirdNothingHappens(app: String?) async {
        let thunderbird = FakeThunderbird()
        thunderbird.installed = false

        await #expect(throws: ThunderbirdRelay.Failure.notInstalled) { try await thunderbird.relay().send(message, to: app) }
        #expect(thunderbird.events.isEmpty)
    }

    /// The shortcut goes to whatever app is in front: it is never posted unless Thunderbird is.
    @Test func aThunderbirdThatStaysBehindGetsNoShortcut() async {
        let thunderbird = FakeThunderbird()
        thunderbird.comesToFront = false

        await #expect(throws: ThunderbirdRelay.Failure.notFrontmost) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["activate"])
    }

    /// No TabMail add-on, or a remapped shortcut: the chat never opens and nothing is typed.
    @Test func aChatThatNeverOpensGetsNothing() async {
        let thunderbird = FakeThunderbird()
        thunderbird.shortcutOpensChat = false

        await #expect(throws: ThunderbirdRelay.Failure.chatNotFocused) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["activate", "openChat"])
        #expect(thunderbird.pasted.isEmpty)
    }

    /// The user switched away while the chat's input settled: nothing is pasted where they went.
    @Test func focusLostBeforeThePasteGetsNothing() async {
        let thunderbird = FakeThunderbird()
        thunderbird.onOpenChat = { fake in
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(50))
                fake.frontmost = false
            }
        }

        await #expect(throws: ThunderbirdRelay.Failure.chatNotFocused) { try await thunderbird.relay(chatInputSettle: 0.5).send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.pasted.isEmpty)
        #expect(!thunderbird.events.contains("return"))
    }

    /// Return could submit something in another app: it is pressed only if the chat still has focus.
    @Test func focusLostDuringThePastePressesNoReturn() async {
        let thunderbird = FakeThunderbird()
        thunderbird.loseFocusOnPaste = true

        await #expect(throws: ThunderbirdRelay.Failure.chatNotFocused) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["activate", "openChat", "paste"])
    }

    /// Thunderbird is in front only as of the last check: the user switching away while the chat's
    /// title is read (before the paste, or before Return) gets nothing in the app they went to.
    /// Accessibility still reports the chat as Thunderbird's focused window.
    @Test(arguments: [(2, [String]()), (3, ["paste"])])
    func switchingAwayDuringTheTitleReadGetsNothing(read: Int, sentBefore: [String]) async {
        let thunderbird = FakeThunderbird()
        thunderbird.focusedTitle = FakeThunderbird.chatTitle
        thunderbird.onTitleRead = { fake, n in
            if n == read { fake.frontmost = false }
        }

        await #expect(throws: ThunderbirdRelay.Failure.chatNotFocused) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["activate"] + sentBefore)
    }

    /// A slow Thunderbird: its window, its coming to the front and its chat opening are each waited
    /// for, and the message then sent once.
    @Test(arguments: ["window", "front", "chat"])
    func waitsForASlowThunderbird(stage: String) async throws {
        let thunderbird = FakeThunderbird()
        switch stage {
        case "window":
            thunderbird.running = false
            thunderbird.hasWindow = false
            thunderbird.windowLag = 3
        case "front":
            thunderbird.frontLag = 3
        default:
            thunderbird.shortcutOpensChat = false
            thunderbird.onTitleRead = { fake, n in
                if n == 3 { fake.focusedTitle = FakeThunderbird.chatTitle }
            }
        }

        try await thunderbird.relay().send(message, to: FakeThunderbird.app)

        #expect(thunderbird.events == (stage == "window" ? ["launch"] : []) + ["activate", "openChat", "paste", "return"])
        #expect(thunderbird.pasted == [message])
    }

    /// The user switching away while the title is first read gets no shortcut in the app they went
    /// to, whether or not the chat has focus in Thunderbird.
    @Test(arguments: [FakeThunderbird.chatTitle, "Inbox - Thunderbird"])
    func switchingAwayDuringTheFirstTitleReadGetsNoShortcut(title: String) async {
        let thunderbird = FakeThunderbird()
        thunderbird.focusedTitle = title
        thunderbird.onTitleRead = { fake, n in
            if n == 1 { fake.frontmost = false }
        }

        await #expect(throws: ThunderbirdRelay.Failure.notFrontmost) { try await thunderbird.relay().send(message, to: FakeThunderbird.app) }
        #expect(thunderbird.events == ["activate"])
    }

    /// Cancelled while the chat's title is read (before the shortcut, the paste, or Return): nothing
    /// more is sent.
    @Test(arguments: [
        (1, "Inbox - Thunderbird", [String]()),
        (2, FakeThunderbird.chatTitle, []),
        (3, FakeThunderbird.chatTitle, ["paste"]),
    ])
    func cancelledDuringTheTitleReadSendsNothingMore(read: Int, title: String, sentBefore: [String]) async {
        let thunderbird = FakeThunderbird()
        thunderbird.focusedTitle = title
        let relay = thunderbird.relay()
        let sending = SendingTask()
        thunderbird.onTitleRead = { _, n in
            if n == read { sending.task?.cancel() }
        }
        sending.task = Task { try await relay.send(message, to: FakeThunderbird.app) }

        await #expect(throws: CancellationError.self) { try await sending.task?.value }
        #expect(thunderbird.events == ["activate"] + sentBefore)
    }

    @Test func cancelledWhileWaitingForTheChatPastesNothing() async {
        let thunderbird = FakeThunderbird()
        thunderbird.shortcutOpensChat = false
        let relay = thunderbird.relay(chatTimeout: 30)
        let sending = Task { try await relay.send(message, to: FakeThunderbird.app) }
        try? await Task.sleep(for: .milliseconds(100))

        sending.cancel()

        await #expect(throws: CancellationError.self) { try await sending.value }
        #expect(thunderbird.pasted.isEmpty)
        #expect(!thunderbird.events.contains("return"))
    }
}

/// The relay's send, for a fake to cancel from inside it.
@MainActor
private final class SendingTask {
    var task: Task<Void, any Error>?
}
