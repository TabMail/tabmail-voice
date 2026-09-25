// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices

/// Gecko (Thunderbird, Firefox) and Electron apps build their accessibility tree only once an
/// assistive app asks for it, and building takes about a second. Until then the focused element
/// is the bare window, so the caret can't be found. Ask each such app as it comes to the front,
/// so the tree is ready by the time the user dictates. Other apps are left alone:
/// `AXEnhancedUserInterface` has window-management side effects in some of them.
@MainActor
final class AccessibilityActivator {
    enum Engine: Equatable {
        case gecko, electron
    }

    private var activated: Set<pid_t> = []
    private var observer: NSObjectProtocol?

    /// Safe to call again (e.g. once Accessibility is granted): the frontmost app is re-checked.
    func start() {
        if observer == nil {
            observer = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
            ) { [weak self] note in
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                MainActor.assumeIsolated { self?.activate(app) }
            }
        }
        activate(NSWorkspace.shared.frontmostApplication)
    }

    private func activate(_ app: NSRunningApplication?) {
        guard AXIsProcessTrusted(), let app, let engine = Self.engine(of: app.bundleURL) else { return }
        let pid = app.processIdentifier
        guard activated.insert(pid).inserted else { return }
        Task.detached { Self.request(engine, pid: pid) }
    }

    /// Which engine needs asking, from the app bundle's contents.
    nonisolated static func engine(
        of bundleURL: URL?, fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> Engine? {
        guard let contents = bundleURL?.appendingPathComponent("Contents") else { return nil }
        if fileExists(contents.appendingPathComponent("MacOS/XUL").path) { return .gecko }
        if fileExists(contents.appendingPathComponent("Frameworks/Electron Framework.framework").path) { return .electron }
        return nil
    }

    private nonisolated static func request(_ engine: Engine, pid: pid_t) {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, DictationConfig.accessibilityActivationTimeout)
        let attribute = engine == .gecko ? "AXEnhancedUserInterface" : "AXManualAccessibility"
        // Gecko answers "unsupported" yet starts its accessibility service; the request is what counts.
        let result = AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue)
        Log.debug("AccessibilityActivator: asked \(engine) app \(pid) (\(result.rawValue))")
    }
}
