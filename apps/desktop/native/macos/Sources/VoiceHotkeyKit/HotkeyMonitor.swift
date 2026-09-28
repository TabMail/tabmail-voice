// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import VoiceHelperSupport

/// Watches the keyboard system-wide and feeds `PushToTalkGesture`, through an event tap so the Space
/// that switches modes during a hold, and hands-free listening's Escape, can be kept from the app in
/// front (a key monitor only observes). The gesture runs here, beside the tap, because whether a key
/// is kept from the app must be decided before the tap returns (ADR-DESK-032).
///
/// The tap can only be created once the app is trusted for Accessibility, so `install()` must be
/// called again after the grant.
@MainActor
public final class HotkeyMonitor {
    private var gesture: PushToTalkGesture
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    /// Keys whose key-down the gesture kept from the app: their key-up is kept from it too.
    private var swallowedKeyUps: Set<UInt16> = []
    private let onAction: (PushToTalkGesture.Action) -> Void

    public init(gesture: PushToTalkGesture, onAction: @escaping (PushToTalkGesture.Action) -> Void) {
        self.gesture = gesture
        self.onAction = onAction
    }

    public var hotkey: DictationHotkey { gesture.hotkey }
    public var isInstalled: Bool { tap != nil }

    /// A new hotkey or new timings. A hold or hands-free listening under way is cancelled.
    public func configure(_ newGesture: PushToTalkGesture) {
        guard newGesture.hotkey != gesture.hotkey || newGesture.tapMaxDuration != gesture.tapMaxDuration
            || newGesture.doubleTapWindow != gesture.doubleTapWindow else { return }
        if gesture.isActive { onAction(.cancel) }
        gesture = newGesture
    }

    /// The dictation ended without the hotkey (length cap, failure, the menu): stop listening hands-free.
    public func dictationEnded() {
        gesture.dictationEnded()
    }

    public func install() {
        uninstall()
        let types: [CGEventType] = [.flagsChanged, .keyDown, .keyUp]
        let mask = types.reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
            callback: hotkeyTapCallback, userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            HelperLog.debug("HotkeyMonitor: event tap not created (Accessibility not granted yet)")
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        HelperLog.debug("HotkeyMonitor installed for \(gesture.hotkey.rawValue)")
    }

    public func uninstall() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
        swallowedKeyUps.removeAll()
    }

    /// Feeds one event, at `time` (seconds of system uptime), to the gesture; whether it may go on to
    /// the app in front. Public for tests.
    public func handle(_ type: CGEventType, keyCode: UInt16, flags: CGEventFlags, isRepeat: Bool, at time: TimeInterval) -> Bool {
        var passes = true
        let action: PushToTalkGesture.Action?
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // macOS switches a tap off when it answers too slowly; switch it back on.
            HelperLog.debug("HotkeyMonitor: event tap was disabled; re-enabling")
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            action = nil
        case .flagsChanged:
            action = gesture.modifierChanged(keyCode: keyCode, isDown: isHotkeyFlagSet(flags), at: time)
        case .keyDown:
            if gesture.owns(keyCode: keyCode) {
                swallowedKeyUps.insert(keyCode)
                passes = false
            }
            action = gesture.keyPressed(keyCode: keyCode, isRepeat: isRepeat)
        case .keyUp:
            passes = swallowedKeyUps.remove(keyCode) == nil
            action = nil
        default:
            action = nil
        }
        // After the tap returns, so the event is on its way before the dictation's work starts.
        if let action {
            DispatchQueue.main.async { [onAction] in onAction(action) }
        }
        return passes
    }

    private func isHotkeyFlagSet(_ flags: CGEventFlags) -> Bool {
        switch gesture.hotkey {
        case .rightOption: flags.contains(.maskAlternate)
        case .function: flags.contains(.maskSecondaryFn)
        }
    }
}

/// The event tap's callback: runs on the main run loop, where the tap's source was added.
private func hotkeyTapCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
    let flags = event.flags
    let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
    let time = ProcessInfo.processInfo.systemUptime
    let passes = MainActor.assumeIsolated { monitor.handle(type, keyCode: keyCode, flags: flags, isRepeat: isRepeat, at: time) }
    return passes ? Unmanaged.passUnretained(event) : nil
}
