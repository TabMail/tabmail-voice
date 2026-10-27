// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import os
import VoiceHelperSupport

/// AX references stay in the reader that captured them. A UUID never resolves in a restarted
/// reader, and neither a process, a title nor a window's position substitutes for that reference.
@MainActor
final class TargetWindows {
    struct Target: @unchecked Sendable {
        var token: String
        var pid: pid_t
        var name: String
        var bundleID: String?
        var window: AXUIElement
        var field: AXUIElement?
        var json: JSON { ["window": .string(token), "pid": .number(Double(pid))] }
    }
    @MainActor
    struct System {
        var frontmost: () -> (pid_t, String, String?)?
        var focusedWindow: (pid_t) -> AXUIElement?
        var windows: (pid_t) -> [AXUIElement]
        var raise: (pid_t, AXUIElement) -> Void
        var clipboardCount: () -> Int
        var focusedElement: (pid_t) -> AXUIElement?
        var now: () -> Double = { Date().timeIntervalSince1970 * 1000 }
        var post: () async throws -> Void

        static let live = System(
            frontmost: { NSWorkspace.shared.frontmostApplication.map { ($0.processIdentifier, $0.localizedName ?? "", $0.bundleIdentifier) } },
            focusedWindow: { ScreenContextReader.focusedWindow(pid: $0) },
            windows: { pid in
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, HelperConfig.contextLookupTimeout)
                return CaretLocator.attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
            },
            raise: { pid, window in
                AXUIElementSetMessagingTimeout(window, HelperConfig.contextLookupTimeout)
                _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, HelperConfig.contextLookupTimeout)
                _ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            },
            clipboardCount: { NSPasteboard.general.changeCount },
            focusedElement: { pid in
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, HelperConfig.contextLookupTimeout)
                guard let focused = CaretLocator.attribute(app, kAXFocusedUIElementAttribute),
                      CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
                return (focused as! AXUIElement)
            },
            post: { try await TextInserter.postTargetCommandV() }
        )
    }
    private let system: System
    private let owner: pid_t
    private let observeEnabled: Bool
    private var previous: Target?
    private var captured: Target?
    nonisolated private let cancelState = OSAllocatedUnfairLock<(token: String?, canceled: Bool)>(initialState: (nil, false))
    private var activation: NSObjectProtocol?
    private var deactivation: NSObjectProtocol?
    private var observer: AXObserver?
    private var observedApp: AXUIElement?

    init(system: System = .live, owner: pid_t = getppid(), observe: Bool = true) {
        self.system = system
        self.owner = owner
        self.observeEnabled = observe
        remember()
        if observe {
            activation = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.remember() }
            }
            deactivation = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didDeactivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                MainActor.assumeIsolated {
                    self?.remember(pid: app.processIdentifier, name: app.localizedName ?? "", bundleID: app.bundleIdentifier)
                }
            }
        }
    }

    /// The focused window can change without an application activation. Observe that app's AX
    /// window changes too; losing or destroying one is checked against its live window list.
    private func observe(_ pid: pid_t) {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        observer = nil
        observedApp = nil
        var next: AXObserver?
        guard AXObserverCreate(pid, { _, _, _, context in
            guard let context else { return }
            let windows = Unmanaged<TargetWindows>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated { windows.remember() }
        }, &next) == .success, let next else { return }
        let app = AXUIElementCreateApplication(pid)
        guard AXObserverAddNotification(next, app, kAXFocusedWindowChangedNotification as CFString, Unmanaged.passUnretained(self).toOpaque()) == .success else { return }
        observer = next
        observedApp = app
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(next), .commonModes)
    }

    func remember() {
        guard let (pid, name, bundleID) = system.frontmost(), pid != owner else { return }
        remember(pid: pid, name: name, bundleID: bundleID)
    }

    private func remember(pid: pid_t, name: String, bundleID: String?) {
        guard pid != owner else { return }
        guard let window = system.focusedWindow(pid) else { previous = nil; return }
        let changedApp = previous?.pid != pid
        previous = Target(token: UUID().uuidString, pid: pid, name: name, bundleID: bundleID, window: window, field: system.focusedElement(pid))
        if changedApp && observeEnabled { observe(pid) }
    }

    func capture() -> JSON {
        guard let front = system.frontmost() else { captured = nil; return .null }
        if front.0 != owner { remember() }
        guard let target = previous, (front.0 == owner || target.pid == front.0), exists(target) else {
            captured = nil
            return .null
        }
        let snapshot = Target(token: UUID().uuidString, pid: target.pid, name: target.name, bundleID: target.bundleID, window: target.window, field: target.field)
        captured = snapshot
        cancelState.withLock { $0 = (snapshot.token, false) }
        return snapshot.json
    }

    func resolve(_ json: JSON) throws -> Target? {
        let accepted = try SharedRequest.call(["targetWindow": json])
        guard let target = captured, accepted == target.json, exists(target) else { return nil }
        return target
    }

    private func exists(_ target: Target) -> Bool { system.windows(target.pid).contains { CFEqual($0, target.window) } }
    private func inFront(_ target: Target) -> Bool {
        guard system.frontmost()?.0 == target.pid, let window = system.focusedWindow(target.pid) else { return false }
        return CFEqual(window, target.window)
    }

    /// Answered off the main actor too: a cancellation arriving while an AX call blocks the main
    /// actor must veto its eventual key-down, rather than wait behind that call.
    nonisolated func cancel(_ json: JSON) throws {
        let accepted = try SharedRequest.call(["targetWindow": json])
        let token = accepted["window"]?.string
        cancelState.withLock { if $0.token == token { $0.canceled = true } }
    }

    private func isCanceled(_ target: Target) -> Bool {
        cancelState.withLock { $0.token != target.token || $0.canceled }
    }

    func paste(_ json: JSON, transaction: Int, deadline: Double) async throws {
        guard let target = try resolve(json) else { throw HelperError("target window unavailable") }
        let end = ContinuousClock.now.advanced(by: HelperConfig.targetActivationTimeout)
        guard system.now() < deadline else { throw HelperError("paste expired") }
        guard !isCanceled(target) else { throw HelperError("paste canceled") }
        if !inFront(target) { system.raise(target.pid, target.window) }
        while !inFront(target) {
            guard !isCanceled(target), ContinuousClock.now < end, system.now() < deadline,
                  exists(target) else { throw HelperError("target activation refused") }
            try await Task.sleep(for: HelperConfig.targetActivationPoll)
        }
        // Keep element identity, never text offsets: typing and terminal output can move the caret.
        // Apps without an accessible focus keep their existing window-only paste path.
        if let field = target.field {
            guard let focused = system.focusedElement(target.pid), CFEqual(field, focused) else {
                throw HelperError("target field unavailable")
            }
        }
        // Nothing may suspend or make another helper round trip between these checks and key-down.
        guard captured?.token == target.token, exists(target), inFront(target),
              system.now() < deadline, system.clipboardCount() == transaction, !isCanceled(target) else {
            throw HelperError("paste is no longer current")
        }
        try await system.post()
    }
}
