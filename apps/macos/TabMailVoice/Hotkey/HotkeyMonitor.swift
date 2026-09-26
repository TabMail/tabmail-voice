// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit

/// Watches the keyboard system-wide and feeds `PushToTalkGesture`, through an event tap so the Space
/// that switches modes during a hold can be kept from the app in front (a key monitor only observes).
///
/// The tap can only be created once the app is trusted for Accessibility, so `install()` must be
/// called again after the grant (see `PermissionsModel`).
@MainActor
final class HotkeyMonitor {
    private var gesture: PushToTalkGesture
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    /// Keys whose key-down the gesture kept from the app: their key-up is kept from it too.
    private var swallowedKeyUps: Set<UInt16> = []
    private let onAction: (PushToTalkGesture.Action) -> Void

    init(hotkey: DictationHotkey, onAction: @escaping (PushToTalkGesture.Action) -> Void) {
        self.gesture = PushToTalkGesture(hotkey: hotkey)
        self.onAction = onAction
    }

    var hotkey: DictationHotkey { gesture.hotkey }

    func setHotkey(_ hotkey: DictationHotkey) {
        guard hotkey != gesture.hotkey else { return }
        if gesture.isHolding { onAction(.cancel) }
        gesture = PushToTalkGesture(hotkey: hotkey)
    }

    func install() {
        uninstall()
        let types: [CGEventType] = [.flagsChanged, .keyDown, .keyUp]
        let mask = types.reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
            callback: hotkeyTapCallback, userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            Log.debug("HotkeyMonitor: event tap not created (Accessibility not granted yet)")
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        Log.debug("HotkeyMonitor installed for \(gesture.hotkey.rawValue)")
    }

    func uninstall() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
        swallowedKeyUps.removeAll()
    }

    /// Feeds one event to the gesture; whether it may go on to the app in front.
    fileprivate func handle(_ type: CGEventType, keyCode: UInt16, flags: CGEventFlags, isRepeat: Bool) -> Bool {
        var passes = true
        let action: PushToTalkGesture.Action?
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // macOS switches a tap off when it answers too slowly; switch it back on.
            Log.debug("HotkeyMonitor: event tap was disabled; re-enabling")
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            action = nil
        case .flagsChanged:
            action = gesture.modifierChanged(keyCode: keyCode, isDown: isHotkeyFlagSet(flags))
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
    let passes = MainActor.assumeIsolated { monitor.handle(type, keyCode: keyCode, flags: flags, isRepeat: isRepeat) }
    return passes ? Unmanaged.passUnretained(event) : nil
}
