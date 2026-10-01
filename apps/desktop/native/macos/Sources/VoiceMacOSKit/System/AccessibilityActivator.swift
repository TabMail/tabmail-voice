// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import VoiceHelperSupport

/// Gecko (Thunderbird, Firefox) and Electron apps build their accessibility tree only once an
/// assistive app asks for it, and building takes about a second. Until then the focused element
/// is the bare window, so the caret can't be found. Ask each such app every time it comes to the
/// front, so the tree is ready by the time the user dictates: an app can turn its tree off again
/// (Electron once VoiceOver goes off), and asking an app whose tree is on changes nothing. An app busy launching can let the request time out; it is asked again
/// a few times while it stays in front, then left until it next comes to the front. Other apps are
/// left alone: `AXEnhancedUserInterface` has window-management side effects in some of them.
@MainActor
final class AccessibilityActivator {
    enum Engine: Equatable {
        case gecko, electron
    }

    private var observer: NSObjectProtocol?
    private let request: @Sendable (Engine, pid_t) -> AXError
    private let retryDelay: Duration
    /// The requests to the app in front, and its retries.
    private var asking: Task<Void, Never>?

    init(
        request: @escaping @Sendable (Engine, pid_t) -> AXError = AccessibilityActivator.request,
        retryDelay: Duration = HelperConfig.accessibilityActivationRetryDelay
    ) {
        self.request = request
        self.retryDelay = retryDelay
    }

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

    /// `app` is in front: asked if it is a Gecko or Electron app (and Accessibility is granted).
    private func activate(_ app: NSRunningApplication?) {
        guard AXIsProcessTrusted(), let app, let engine = Self.engine(of: app.bundleURL) else {
            cameToFront(nil)
            return
        }
        cameToFront((engine, app.processIdentifier))
    }

    /// An app came to the front: the asking of the app before it stops, and `target`, the app to ask
    /// if it needs asking, is asked. The asking, for tests to await.
    @discardableResult
    func cameToFront(_ target: (engine: Engine, pid: pid_t)?) -> Task<Void, Never>? {
        asking?.cancel()
        asking = target.map { ask($0.engine, pid: $0.pid) }
        return asking
    }

    /// Asks the app, and again after `retryDelay` while it doesn't answer in time (`cannotComplete`),
    /// at most `accessibilityActivationAttempts` requests in all. Any other answer counts, Gecko's
    /// "unsupported" included.
    private func ask(_ engine: Engine, pid: pid_t) -> Task<Void, Never> {
        let request = self.request, retryDelay = self.retryDelay
        return Task {
            for attempt in 1...HelperConfig.accessibilityActivationAttempts {
                let result = await Task.detached { request(engine, pid) }.value
                HelperLog.debug("AccessibilityActivator: asked \(engine) app \(pid) (\(result.rawValue)), attempt \(attempt)")
                guard result == .cannotComplete, attempt < HelperConfig.accessibilityActivationAttempts else { return }
                guard (try? await Task.sleep(for: retryDelay)) != nil else { return }
            }
        }
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

    nonisolated static func request(_ engine: Engine, pid: pid_t) -> AXError {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, HelperConfig.accessibilityActivationTimeout)
        let attribute = engine == .gecko ? "AXEnhancedUserInterface" : "AXManualAccessibility"
        // Gecko answers "unsupported" yet starts its accessibility service; the request is what counts.
        return AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue)
    }
}
