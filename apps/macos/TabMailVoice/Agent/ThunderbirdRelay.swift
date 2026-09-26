// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// Sends a chat message to TabMail's chat in Thunderbird by driving Thunderbird from outside: bring it
/// to the front (launching it first if it isn't running), open the chat with the add-on's shortcut
/// (⌥⌘L), paste the message and press Return. A spike that needs no Thunderbird change
/// (ADR-DESK-014); it never pastes unless the TabMail chat window has focus.
@MainActor
final class ThunderbirdRelay {
    /// What the relay does to the system. Injected so tests drive it without launching apps or
    /// posting keystrokes.
    struct System {
        /// Thunderbird's app bundle, when installed.
        var applicationURL: @MainActor () -> URL?
        var isRunning: @MainActor () -> Bool
        var launch: @MainActor (URL) async throws -> Void
        /// True once Thunderbird shows a window.
        var hasWindow: @MainActor () async -> Bool
        /// Asks Thunderbird to come to the front.
        var activate: @MainActor () async -> Void
        var isFrontmost: @MainActor () -> Bool
        /// The title of Thunderbird's focused window.
        var focusedWindowTitle: @MainActor () async -> String?
        /// Posts the add-on's open-chat shortcut.
        var openChat: @MainActor () async -> Void
        /// Pastes into the focused field.
        var paste: @MainActor (String) async -> Void
        /// Posts Return, which sends the chat message.
        var pressReturn: @MainActor () async -> Void
    }

    enum Failure: LocalizedError, Equatable {
        case notInstalled
        case didNotLaunch
        case notFrontmost
        /// The chat window did not open, or lost focus before the message was in.
        case chatNotFocused

        var errorDescription: String? {
            switch self {
            case .notInstalled: "Mail and calendar requests need Thunderbird with TabMail."
            case .didNotLaunch: "Thunderbird didn't open. Try again."
            case .notFrontmost: "Couldn't bring Thunderbird to the front."
            case .chatNotFocused: "Couldn't open TabMail's chat in Thunderbird."
            }
        }
    }

    private let system: System
    // Internal for tests.
    var launchTimeout = DictationConfig.thunderbirdLaunchTimeout
    var addonSettle = DictationConfig.thunderbirdAddonSettle
    var activateTimeout = DictationConfig.thunderbirdActivateTimeout
    var chatTimeout = DictationConfig.thunderbirdChatTimeout
    var chatInputSettle = DictationConfig.thunderbirdChatInputSettle
    var pollInterval = DictationConfig.thunderbirdPollInterval

    init(system: System) {
        self.system = system
    }

    /// The email app's bundle, when one is set up and installed.
    var applicationURL: URL? { system.applicationURL() }

    /// Types `message` into TabMail's chat and sends it. Throws `Failure`, or `CancellationError` when
    /// cancelled; either way nothing is pasted outside the chat window.
    func send(_ message: String) async throws {
        guard let url = system.applicationURL() else { throw Failure.notInstalled }
        if !system.isRunning() {
            Log.debug("ThunderbirdRelay: launching Thunderbird")
            try await system.launch(url)
            guard try await wait(launchTimeout, until: system.hasWindow) else { throw Failure.didNotLaunch }
            // The add-on registers its shortcut only once its background page has loaded.
            try await Task.sleep(for: .seconds(addonSettle))
        }
        await system.activate()
        guard try await wait(activateTimeout, until: system.isFrontmost) else { throw Failure.notFrontmost }
        if await !isChatFocused() {
            // The shortcut goes to whatever app is in front, and the user may have switched, or
            // cancelled, during the title read.
            guard system.isFrontmost() else { throw Failure.notFrontmost }
            try Task.checkCancellation()
            Log.debug("ThunderbirdRelay: opening the chat")
            await system.openChat()
            guard try await wait(chatTimeout, until: isChatFocused) else { throw Failure.chatNotFocused }
        }
        try await Task.sleep(for: .seconds(chatInputSettle))
        // The user may have moved on, or cancelled, while this waited: paste and send only into the
        // chat, and only for a request still wanted.
        guard await isChatFocused() else { throw Failure.chatNotFocused }
        try Task.checkCancellation()
        await system.paste(message)
        guard await isChatFocused() else { throw Failure.chatNotFocused }
        try Task.checkCancellation()
        await system.pressReturn()
        Log.debug("ThunderbirdRelay: sent \(message.count) chars")
        Log.content("ThunderbirdRelay: sent", message)
    }

    /// The title is read first: Thunderbird being in front is only a fact after the read's `await`.
    /// The whole title must match; a window that merely mentions the chat, such as a draft replying
    /// to a message about it ("Write: Re: TabMail Chat feedback"), is not it.
    private func isChatFocused() async -> Bool {
        guard let title = await system.focusedWindowTitle(), system.isFrontmost() else { return false }
        return title == DictationConfig.thunderbirdChatWindowTitle
    }

    /// Whether `condition` holds within `timeout`, checking every `pollInterval`.
    private func wait(_ timeout: TimeInterval, until condition: @MainActor () async -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while await !condition() {
            guard ContinuousClock.now < deadline else { return false }
            try await Task.sleep(for: .seconds(pollInterval))
        }
        return true
    }
}

extension ThunderbirdRelay.System {
    /// The real Thunderbird, driven through Launch Services, Accessibility and posted keystrokes.
    /// `bundleIdentifier` names the email app at each call (`EmailClient`), so a change in Settings
    /// applies at once; nil means there is none.
    @MainActor
    static func live(
        bundleIdentifier: @escaping @MainActor () -> String?, inserter: TextInserter = TextInserter()
    ) -> Self {
        func running() -> NSRunningApplication? {
            guard let id = bundleIdentifier() else { return nil }
            return NSRunningApplication.runningApplications(withBundleIdentifier: id).first { !$0.isTerminated }
        }
        /// Runs `probe` on Thunderbird's Accessibility element off the main thread, where the hotkey's
        /// event tap runs: a slow Thunderbird holds up only the relay. `absent` without Thunderbird.
        func accessibility<T: Sendable>(absent: T, _ probe: @escaping @Sendable (AXUIElement) -> T) async -> T {
            guard let pid = running()?.processIdentifier else { return absent }
            return await Task.detached { probe(timed(AXUIElementCreateApplication(pid))) }.value
        }
        return Self(
            applicationURL: { bundleIdentifier().flatMap(NSWorkspace.shared.urlForApplication(withBundleIdentifier:)) },
            isRunning: { running() != nil },
            launch: { url in
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            },
            hasWindow: {
                await accessibility(absent: false) { app in
                    (CaretLocator.attribute(app, kAXWindowsAttribute) as? [AXUIElement]).map { !$0.isEmpty } ?? false
                }
            },
            activate: {
                // This app is never active (menu bar, non-activating overlay), and macOS's cooperative
                // activation ignores an activation request from an inactive app; Accessibility can
                // still bring an app to the front.
                let result: Int32? = await accessibility(absent: nil) { app in
                    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue).rawValue
                }
                guard let result else { return }
                Log.debug("ThunderbirdRelay: asked Thunderbird to the front (\(result))")
            },
            isFrontmost: {
                guard let id = bundleIdentifier() else { return false }
                return NSWorkspace.shared.frontmostApplication?.bundleIdentifier == id
            },
            focusedWindowTitle: {
                await accessibility(absent: nil) { app in
                    guard let window = CaretLocator.attribute(app, kAXFocusedWindowAttribute) else { return nil }
                    return CaretLocator.attribute(timed(window as! AXUIElement), kAXTitleAttribute) as? String
                }
            },
            openChat: { await TextInserter.postKeystroke(CGKeyCode(kVK_ANSI_L), flags: [.maskAlternate, .maskCommand]) },
            paste: { await inserter.insert($0) },
            pressReturn: { await TextInserter.postKeystroke(CGKeyCode(kVK_Return), flags: []) }
        )
    }
}

/// `element`, whose Accessibility calls into Thunderbird give up after
/// `thunderbirdAccessibilityTimeout`. Each element has its own timeout: set it on every element asked.
private func timed(_ element: AXUIElement) -> AXUIElement {
    AXUIElementSetMessagingTimeout(element, DictationConfig.thunderbirdAccessibilityTimeout)
    return element
}
