// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit

/// Watches the keyboard system-wide and feeds `PushToTalkGesture`.
///
/// Global key monitors only receive events once the app is trusted for Accessibility, and
/// they do not start delivering retroactively, so `install()` must be called again after
/// the grant (see `PermissionsModel`).
@MainActor
final class HotkeyMonitor {
    private var gesture: PushToTalkGesture
    private var monitors: [Any] = []
    private let onAction: (PushToTalkGesture.Action) -> Void

    init(hotkey: DictationHotkey, onAction: @escaping (PushToTalkGesture.Action) -> Void) {
        self.gesture = PushToTalkGesture(hotkey: hotkey)
        self.onAction = onAction
    }

    var hotkey: DictationHotkey { gesture.hotkey }

    func setHotkey(_ hotkey: DictationHotkey) {
        guard hotkey != gesture.hotkey else { return }
        if gesture.isActive { onAction(.cancel) }
        gesture = PushToTalkGesture(hotkey: hotkey)
    }

    func install() {
        uninstall()
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown]
        // Global: events delivered to other apps. Local: events delivered to our own windows
        // (Settings), which global monitors never see.
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.handle(event) }
        }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.handle(event) }
            return event
        }) {
            monitors.append(local)
        }
        Log.debug("HotkeyMonitor installed for \(gesture.hotkey.rawValue)")
    }

    /// The dictation ended without the hotkey (length cap, failure, menu): stop listening hands-free.
    func dictationEnded() {
        gesture.dictationEnded()
    }

    func uninstall() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
    }

    private func handle(_ event: NSEvent) {
        let action: PushToTalkGesture.Action?
        switch event.type {
        case .flagsChanged:
            action = gesture.modifierChanged(keyCode: event.keyCode, isDown: isHotkeyFlagSet(event.modifierFlags), at: event.timestamp)
        case .keyDown:
            action = gesture.otherKeyPressed()
        default:
            action = nil
        }
        if let action { onAction(action) }
    }

    private func isHotkeyFlagSet(_ flags: NSEvent.ModifierFlags) -> Bool {
        switch gesture.hotkey {
        case .rightOption: flags.contains(.option)
        case .function: flags.contains(.function)
        }
    }
}
