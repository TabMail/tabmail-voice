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
///
/// While the chat window is open it also tells of a click anywhere and of another app coming to the
/// front (`ChatEvent`): the app closes the chat window on a click elsewhere or an app switch, when
/// the user wants that (ADR-DESK-022). The clicks come from a second tap, listen-only, so a click is
/// never held back, and only while the chat window is open.
@MainActor
public final class HotkeyMonitor {
    /// What the app hears of while the chat window is open.
    public enum ChatEvent: String, Sendable {
        /// A mouse button went down, anywhere: on the chat window or elsewhere, which the app tells.
        case mouseDown = "chatMouseDown"
        /// Another app came to the front.
        case focusChanged = "chatFocusChanged"
    }

    private var gesture: PushToTalkGesture
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    /// The clicks' tap, and the observer of the app in front, while the chat window is open.
    private var chatTap: CFMachPort?
    private var chatSource: CFRunLoopSource?
    private var frontObserver: NSObjectProtocol?
    /// Keys whose key-down the gesture kept from the app: their key-up is kept from it too.
    private var swallowedKeyUps: Set<UInt16> = []
    private let onAction: (PushToTalkGesture.Action) -> Void
    private let onChatEvent: (ChatEvent) -> Void

    public init(
        gesture: PushToTalkGesture, onAction: @escaping (PushToTalkGesture.Action) -> Void,
        onChatEvent: @escaping (ChatEvent) -> Void = { _ in }
    ) {
        self.gesture = gesture
        self.onAction = onAction
        self.onChatEvent = onChatEvent
    }

    public var hotkey: DictationHotkey { gesture.hotkey }
    public var isInstalled: Bool { tap != nil }

    /// A new hotkey or new timings. A hold or hands-free listening under way is canceled; whether the
    /// chat window is open carries over.
    public func configure(_ newGesture: PushToTalkGesture) {
        guard newGesture.hotkey != gesture.hotkey || newGesture.tapMaxDuration != gesture.tapMaxDuration
            || newGesture.doubleTapWindow != gesture.doubleTapWindow else { return }
        if gesture.isActive { onAction(.cancel) }
        let isChatOpen = gesture.isChatOpen
        gesture = newGesture
        gesture.isChatOpen = isChatOpen
    }

    /// The chat window opened or closed: Escape closes it while it is open, and clicks and app
    /// switches are told meanwhile.
    public func setChatOpen(_ isOpen: Bool) {
        gesture.isChatOpen = isOpen
        if isOpen { watchChat() } else { unwatchChat() }
    }

    /// A mouse button went down (the clicks' tap). Public for tests.
    public func mouseWentDown() {
        guard gesture.isChatOpen else { return }
        onChatEvent(.mouseDown)
    }

    private func watchChat() {
        if frontObserver == nil {
            frontObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.gesture.isChatOpen else { return }
                    self.onChatEvent(.focusChanged)
                }
            }
        }
        guard chatTap == nil else { return }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: chatTapMask,
            callback: chatTapCallback, userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            HelperLog.debug("HotkeyMonitor: click tap not created (Accessibility not granted)")
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        chatTap = tap
        chatSource = source
    }

    private func unwatchChat() {
        if let frontObserver { NSWorkspace.shared.notificationCenter.removeObserver(frontObserver) }
        frontObserver = nil
        if let chatTap {
            CGEvent.tapEnable(tap: chatTap, enable: false)
            CFMachPortInvalidate(chatTap)
        }
        if let chatSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), chatSource, .commonModes) }
        chatTap = nil
        chatSource = nil
    }

    /// The clicks' tap was switched off by macOS: switched back on.
    fileprivate func chatTapDisabled() {
        if let chatTap { CGEvent.tapEnable(tap: chatTap, enable: true) }
    }

    /// Nothing listens hands-free (the dictation ended without the hotkey, or a double tap's release
    /// found no dictation listening): stop listening hands-free.
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
            action = gesture.modifierChanged(keyCode: keyCode, isDown: isHotkeyFlagSet(flags), at: time, agent: flags.contains(.maskShift))
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

/// What the clicks' tap hears: every mouse button going down, and nothing else.
let chatTapMask: CGEventMask = [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown]
    .reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }

/// The clicks' tap's callback, on the main run loop: listen-only, so what it returns is ignored.
func chatTapCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    MainActor.assumeIsolated {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput: monitor.chatTapDisabled()
        default: monitor.mouseWentDown()
        }
    }
    return Unmanaged.passUnretained(event)
}
