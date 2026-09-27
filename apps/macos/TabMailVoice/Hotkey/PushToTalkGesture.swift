// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon.HIToolbox
import Foundation

/// The modifier key the user holds to dictate.
enum DictationHotkey: String, CaseIterable, Identifiable, Sendable {
    case rightOption
    case function

    var id: String { rawValue }

    var keyCode: UInt16 {
        switch self {
        case .rightOption: UInt16(kVK_RightOption)
        case .function: UInt16(kVK_Function)
        }
    }

    var displayName: String {
        switch self {
        case .rightOption: "Right Option (⌥)"
        case .function: "Fn / Globe (🌐)"
        }
    }

    /// The key as a tip's keycap names it.
    var keycap: String {
        switch self {
        case .rightOption: "right ⌥"
        case .function: "fn"
        }
    }
}

/// What the speech is for: text to insert, or a request for the agent to carry out. Space, pressed
/// while the hotkey is held, switches between them.
enum DictationMode: Equatable, Sendable {
    case dictation
    case agent

    /// The other mode.
    var toggled: DictationMode {
        switch self {
        case .dictation: .agent
        case .agent: .dictation
        }
    }
}

/// Pure push-to-talk recogniser: turns raw modifier/key events into start / finish / cancel / toggle.
///
/// - Pressing the hotkey starts a dictation; releasing it finishes the hold. A release too soon to be
///   deliberate (a tap) is discarded by the controller, unseen.
/// - A tap followed by another press within `doubleTapWindow` starts a hands-free dictation. Held, that
///   second press finishes on release like any hold; tapped, the dictation goes on without the key
///   until the hotkey is tapped again (finish) or Escape is pressed (cancel).
/// - Space during the hold, or while listening hands-free, switches between dictation and agent mode.
///   The monitor keeps that Space (and hands-free listening's Escape) from the app in front
///   (`owns(keyCode:)`); its auto-repeat switches nothing.
/// - Pressing any other key during a hold means the user is typing (e.g. a ⌥-letter shortcut), so it
///   is cancelled and nothing is inserted. Hands-free, other keys reach the app and change nothing.
///
/// Times are seconds on one monotonic clock.
struct PushToTalkGesture: Sendable {
    enum Action: Equatable, Sendable {
        case start
        /// The second press of a double tap: a dictation that needs no hold.
        case startHandsFree
        case finish
        case cancel
        case toggleMode
    }

    static let toggleKeyCode = UInt16(kVK_Space)
    static let cancelKeyCode = UInt16(kVK_Escape)

    let hotkey: DictationHotkey
    /// A press released within this long is a tap: it starts no dictation (the controller discards
    /// it unseen), but it can be the first half of a double tap.
    let tapMaxDuration: TimeInterval
    /// A second press this soon after a tap's release makes a double tap.
    let doubleTapWindow: TimeInterval
    private(set) var isHolding = false
    /// A dictation is listening without the key held; the next press finishes it.
    private(set) var isHandsFree = false
    /// Set when the hold ended before its key-up (a chord cancelled it, or its press finished
    /// hands-free listening); the eventual key-up must then be swallowed.
    private var holdIsOver = false
    private var pressedAt: TimeInterval = 0
    /// The press being held is a double tap's second press.
    private var pressIsDoubleTap = false
    /// When the last tap was released, while a second press can still make it a double tap.
    private var lastTapReleasedAt: TimeInterval?

    init(
        hotkey: DictationHotkey,
        tapMaxDuration: TimeInterval = DictationConfig.minimumHoldDuration.timeInterval,
        doubleTapWindow: TimeInterval = DictationConfig.doubleTapWindow.timeInterval
    ) {
        self.hotkey = hotkey
        self.tapMaxDuration = tapMaxDuration
        self.doubleTapWindow = doubleTapWindow
    }

    /// Whether a hold or hands-free listening is under way.
    var isActive: Bool { isHolding || isHandsFree }

    /// A modifier changed at `time`. `isDown` is whether the hotkey's modifier flag is now set.
    mutating func modifierChanged(keyCode: UInt16, isDown: Bool, at time: TimeInterval) -> Action? {
        guard keyCode == hotkey.keyCode else { return nil }
        if isDown {
            guard !isHolding else { return nil }
            isHolding = true
            holdIsOver = false
            pressedAt = time
            if isHandsFree {
                isHandsFree = false
                holdIsOver = true
                return .finish
            }
            if let tap = lastTapReleasedAt, time - tap <= doubleTapWindow {
                lastTapReleasedAt = nil
                pressIsDoubleTap = true
                return .startHandsFree
            }
            pressIsDoubleTap = false
            return .start
        }
        guard isHolding else { return nil }
        isHolding = false
        let wasDoubleTap = pressIsDoubleTap
        pressIsDoubleTap = false
        if holdIsOver {
            holdIsOver = false
            return nil
        }
        let isTap = time - pressedAt < tapMaxDuration
        if wasDoubleTap {
            guard isTap else { return .finish }
            isHandsFree = true
            return nil
        }
        lastTapReleasedAt = isTap ? time : nil
        return .finish
    }

    /// Whether a key-down of `keyCode` belongs to the gesture, and so must not reach the app in front:
    /// Space while a hold or hands-free listening is under way, and Escape while listening hands-free.
    func owns(keyCode: UInt16) -> Bool {
        if isHandsFree { return keyCode == Self.toggleKeyCode || keyCode == Self.cancelKeyCode }
        return isHolding && !holdIsOver && keyCode == Self.toggleKeyCode
    }

    /// A non-modifier key was pressed somewhere; `isRepeat` for its auto-repeat.
    mutating func keyPressed(keyCode: UInt16, isRepeat: Bool) -> Action? {
        // Typing between two taps makes them no double tap.
        lastTapReleasedAt = nil
        if isHandsFree {
            switch keyCode {
            case Self.toggleKeyCode: return isRepeat ? nil : .toggleMode
            case Self.cancelKeyCode:
                isHandsFree = false
                return .cancel
            default: return nil
            }
        }
        guard isHolding, !holdIsOver else { return nil }
        if keyCode == Self.toggleKeyCode { return isRepeat ? nil : .toggleMode }
        holdIsOver = true
        return .cancel
    }

    /// The dictation ended without the hotkey (length cap, failure, Escape, the menu): hands-free
    /// listening is over, so the next press starts afresh and Space and Escape reach the app again.
    mutating func dictationEnded() {
        isHandsFree = false
    }
}

extension Duration {
    /// This duration in seconds.
    var timeInterval: TimeInterval {
        let (seconds, attoseconds) = components
        return TimeInterval(seconds) + TimeInterval(attoseconds) / 1e18
    }
}
