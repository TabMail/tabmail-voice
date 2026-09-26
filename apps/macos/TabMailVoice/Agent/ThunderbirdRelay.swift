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
        var hasWindow: @MainActor () -> Bool
        /// Asks Thunderbird to come to the front.
        var activate: @MainActor () -> Void
        var isFrontmost: @MainActor () -> Bool
        /// The title of Thunderbird's focused window.
        var focusedWindowTitle: @MainActor () -> String?
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

    init(system: System = .live()) {
        self.system = system
    }

    var isInstalled: Bool { system.applicationURL() != nil }

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
        system.activate()
        guard try await wait(activateTimeout, until: system.isFrontmost) else { throw Failure.notFrontmost }
        if !isChatFocused() {
            Log.debug("ThunderbirdRelay: opening the chat")
            await system.openChat()
            guard try await wait(chatTimeout, until: isChatFocused) else { throw Failure.chatNotFocused }
        }
        try await Task.sleep(for: .seconds(chatInputSettle))
        // The user may have moved on while this waited: paste and send only into the chat.
        guard isChatFocused() else { throw Failure.chatNotFocused }
        await system.paste(message)
        guard isChatFocused() else { throw Failure.chatNotFocused }
        await system.pressReturn()
        Log.debug("ThunderbirdRelay: sent \(message.count) chars")
    }

    private func isChatFocused() -> Bool {
        system.isFrontmost() && system.focusedWindowTitle()?.contains(DictationConfig.thunderbirdChatWindowTitle) == true
    }

    /// Whether `condition` holds within `timeout`, checking every `pollInterval`.
    private func wait(_ timeout: TimeInterval, until condition: @MainActor () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while !condition() {
            guard ContinuousClock.now < deadline else { return false }
            try await Task.sleep(for: .seconds(pollInterval))
        }
        return true
    }
}

extension ThunderbirdRelay.System {
    /// The real Thunderbird, driven through Launch Services, Accessibility and posted keystrokes.
    @MainActor
    static func live(
        bundleIdentifier: String = DictationConfig.thunderbirdBundleIdentifier, inserter: TextInserter = TextInserter()
    ) -> Self {
        func running() -> NSRunningApplication? {
            NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first { !$0.isTerminated }
        }
        func element() -> AXUIElement? {
            guard let app = running() else { return nil }
            let element = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(element, DictationConfig.thunderbirdAccessibilityTimeout)
            return element
        }
        return Self(
            applicationURL: { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) },
            isRunning: { running() != nil },
            launch: { url in
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            },
            hasWindow: {
                guard let app = element(), let windows = CaretLocator.attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { return false }
                return !windows.isEmpty
            },
            activate: {
                // This app is never active (menu bar, non-activating overlay), and macOS's cooperative
                // activation ignores an activation request from an inactive app; Accessibility can
                // still bring an app to the front.
                guard let app = element() else { return }
                let result = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                Log.debug("ThunderbirdRelay: asked Thunderbird to the front (\(result.rawValue))")
            },
            isFrontmost: { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleIdentifier },
            focusedWindowTitle: {
                guard let app = element(), let window = CaretLocator.attribute(app, kAXFocusedWindowAttribute) else { return nil }
                return CaretLocator.attribute(window as! AXUIElement, kAXTitleAttribute) as? String
            },
            openChat: { await TextInserter.postKeystroke(CGKeyCode(kVK_ANSI_L), flags: [.maskAlternate, .maskCommand]) },
            paste: { await inserter.insert($0) },
            pressReturn: { await TextInserter.postKeystroke(CGKeyCode(kVK_Return), flags: []) }
        )
    }
}
