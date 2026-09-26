// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// Sends a chat message to TabMail's chat in Thunderbird by driving Thunderbird from outside: bring it
/// to the front (launching it first if it isn't running), open the chat with the add-on's shortcut
/// (⌥⌘L), paste the message and press Return. A spike that needs no Thunderbird change
/// (ADR-DESK-014); it never pastes unless the TabMail chat's input has focus.
@MainActor
final class ThunderbirdRelay {
    /// What the relay does to the system, to the email app named by its bundle identifier. Injected
    /// so tests drive it without launching apps or posting keystrokes.
    struct System {
        /// The app's bundle, when installed.
        var applicationURL: @MainActor (String) -> URL?
        var isRunning: @MainActor (String) -> Bool
        var launch: @MainActor (URL) async throws -> Void
        /// True once the app shows a window.
        var hasWindow: @MainActor (String) async -> Bool
        /// Asks the app to come to the front.
        var activate: @MainActor (String) async -> Void
        var isFrontmost: @MainActor (String) -> Bool
        /// The app's focused element, if any.
        var focusedElement: @MainActor (String) async -> FocusedElement?
        /// Posts the add-on's open-chat shortcut.
        var openChat: @MainActor () async -> Void
        /// Pastes into the focused field.
        var paste: @MainActor (String) async -> Void
        /// Posts Return, which sends the chat message.
        var pressReturn: @MainActor () async -> Void
    }

    /// An element's Accessibility role and the title of the window it is in.
    struct FocusedElement: Equatable, Sendable {
        var role: String?
        var windowTitle: String?
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
    var pollInterval = DictationConfig.thunderbirdPollInterval

    init(system: System) {
        self.system = system
    }

    /// The bundle of the email app `app`, when there is one and it is installed.
    func applicationURL(for app: String?) -> URL? { app.flatMap(system.applicationURL) }

    /// Types `message` into TabMail's chat in the email app `app` (a bundle identifier, from the
    /// dictation's settings) and sends it. Throws `Failure`, or `CancellationError` when cancelled;
    /// either way nothing is pasted outside that app's chat window.
    func send(_ message: String, to app: String?) async throws {
        guard let app, let url = system.applicationURL(app) else { throw Failure.notInstalled }
        if !system.isRunning(app) {
            Log.debug("ThunderbirdRelay: launching Thunderbird")
            try await system.launch(url)
            guard try await wait(launchTimeout, until: { await self.system.hasWindow(app) }) else { throw Failure.didNotLaunch }
            // The add-on registers its shortcut only once its background page has loaded.
            try await Task.sleep(for: .seconds(addonSettle))
        }
        await system.activate(app)
        guard try await wait(activateTimeout, until: { self.system.isFrontmost(app) }) else { throw Failure.notFrontmost }
        if await !isChatFocused(app) {
            // The shortcut goes to whatever app is in front, and the user may have switched, or
            // cancelled, during the focus read.
            guard system.isFrontmost(app) else { throw Failure.notFrontmost }
            try Task.checkCancellation()
            Log.debug("ThunderbirdRelay: opening the chat")
            await system.openChat()
            guard try await wait(chatTimeout, until: { await self.isChatFocused(app) }) else { throw Failure.chatNotFocused }
            Log.debug("ThunderbirdRelay: the chat is ready")
        }
        // The user may have moved on, or cancelled, while this waited: paste and send only into the
        // chat, and only for a request still wanted.
        guard await isChatFocused(app) else { throw Failure.chatNotFocused }
        try Task.checkCancellation()
        await system.paste(message)
        guard await isChatFocused(app) else { throw Failure.chatNotFocused }
        try Task.checkCancellation()
        await system.pressReturn()
        Log.debug("ThunderbirdRelay: sent \(message.count) chars")
        Log.content("ThunderbirdRelay: sent", message)
    }

    /// Whether the chat is ready for a message: its input has focus, which the chat gives it only
    /// once it has loaded (a chat just opened has its title well before). The focus is read first:
    /// `app` being in front is only a fact after the read's `await`. The whole title must match; a
    /// window that merely mentions the chat, such as a draft replying to a message about it
    /// ("Write: Re: TabMail Chat feedback"), is not it.
    private func isChatFocused(_ app: String) async -> Bool {
        guard let focused = await system.focusedElement(app), system.isFrontmost(app) else { return false }
        return focused.role == DictationConfig.thunderbirdChatInputRole && focused.windowTitle == DictationConfig.thunderbirdChatWindowTitle
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
    @MainActor
    static func live(inserter: TextInserter = TextInserter()) -> Self {
        func running(_ app: String) -> NSRunningApplication? {
            NSRunningApplication.runningApplications(withBundleIdentifier: app).first { !$0.isTerminated }
        }
        /// Runs `probe` on the app's Accessibility element off the main thread, where the hotkey's
        /// event tap runs: a slow Thunderbird holds up only the relay. `absent` when it isn't running.
        func accessibility<T: Sendable>(_ app: String, absent: T, _ probe: @escaping @Sendable (AXUIElement) -> T) async -> T {
            guard let pid = running(app)?.processIdentifier else { return absent }
            return await Task.detached { probe(timed(AXUIElementCreateApplication(pid))) }.value
        }
        return Self(
            applicationURL: { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) },
            isRunning: { running($0) != nil },
            launch: { url in
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            },
            hasWindow: { app in
                await accessibility(app, absent: false) { app in
                    (CaretLocator.attribute(app, kAXWindowsAttribute) as? [AXUIElement]).map { !$0.isEmpty } ?? false
                }
            },
            activate: { app in
                // This app is never active (menu bar, non-activating overlay), and macOS's cooperative
                // activation ignores an activation request from an inactive app; Accessibility can
                // still bring an app to the front.
                let result: Int32? = await accessibility(app, absent: nil) { app in
                    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue).rawValue
                }
                guard let result else { return }
                Log.debug("ThunderbirdRelay: asked Thunderbird to the front (\(result))")
            },
            isFrontmost: { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == $0 },
            focusedElement: { app in
                await accessibility(app, absent: ThunderbirdRelay.FocusedElement?.none) { app in
                    guard let element = CaretLocator.attribute(app, kAXFocusedUIElementAttribute) else { return nil }
                    let focused = timed(element as! AXUIElement)
                    let window = CaretLocator.attribute(focused, kAXWindowAttribute).map { timed($0 as! AXUIElement) }
                    return ThunderbirdRelay.FocusedElement(
                        role: CaretLocator.attribute(focused, kAXRoleAttribute) as? String,
                        windowTitle: window.flatMap { CaretLocator.attribute($0, kAXTitleAttribute) as? String }
                    )
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
