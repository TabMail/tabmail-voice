// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon.HIToolbox
import Foundation

/// The modifier key the user holds to dictate.
public enum DictationHotkey: String, CaseIterable, Identifiable, Sendable {
    case rightOption
    case function

    public var id: String { rawValue }

    public var keyCode: UInt16 {
        switch self {
        case .rightOption: UInt16(kVK_RightOption)
        case .function: UInt16(kVK_Function)
        }
    }

    /// The Globe key's own key code, which Carbon has no name for. macOS sends a key-down and key-up
    /// of it as fn is released from a tap (measured 2026-09-27: every tap, 0–3 ms after the release,
    /// with the Globe action on Do Nothing).
    public static let globeKeyCode: UInt16 = 0xB3
}

/// Pure push-to-talk recognizer: turns raw modifier/key events into start / finish / cancel / toggle.
///
/// - Pressing the hotkey starts a dictation; releasing it finishes the hold. A release too soon to be
///   deliberate (a tap) is discarded by the controller, unseen.
/// - A tap followed by another press within `doubleTapWindow` starts a hands-free dictation. Held, that
///   second press finishes on release like any hold; tapped, the dictation goes on without the key
///   until the hotkey is tapped again (finish) or Escape is pressed (cancel).
/// - A third press within `doubleTapWindow` of that second tap's release (a triple tap) shows the paste
///   history instead of finishing: the hands-free dictation it started has heard nothing yet.
/// - Space during the hold, or while listening hands-free, switches between dictation and agent mode.
///   The monitor keeps that Space (and hands-free listening's Escape) from the app in front
///   (`owns(keyCode:)`); its auto-repeat switches nothing.
/// - Pressing any other key during a hold means the user is typing (e.g. a ⌥-letter shortcut), so it
///   is canceled and nothing is inserted. Hands-free, other keys reach the app and change nothing.
/// - While the chat window is open, Escape closes it (a follow-up under way with it), and is kept from
///   the app in front.
///
/// Times are seconds on one monotonic clock.
public struct PushToTalkGesture: Sendable {
    public enum Action: String, Equatable, Sendable {
        case start
        /// The second press of a double tap: a dictation that needs no hold.
        case startHandsFree
        /// That second press was released as a tap: the dictation listens on without the key.
        case listenHandsFree
        case finish
        case cancel
        case toggleMode
        /// Escape while the chat window is open.
        case closeChat
        /// A triple tap: the paste history, the hands-free dictation the second tap started dropped.
        case showHistory
    }

    public static let toggleKeyCode = UInt16(kVK_Space)
    public static let cancelKeyCode = UInt16(kVK_Escape)

    public let hotkey: DictationHotkey
    /// A press released within this long is a tap: it starts no dictation (the controller discards
    /// it unseen), but it can be the first half of a double tap.
    public let tapMaxDuration: TimeInterval
    /// A second press this soon after a tap's release makes a double tap.
    public let doubleTapWindow: TimeInterval
    public private(set) var isHolding = false
    /// A dictation is listening without the key held; the next press finishes it.
    public private(set) var isHandsFree = false
    /// Set when the hold ended before its key-up (a chord canceled it, or its press finished
    /// hands-free listening); the eventual key-up must then be swallowed.
    private var holdIsOver = false
    private var pressedAt: TimeInterval = 0
    /// The press being held is a double tap's second press.
    private var pressIsDoubleTap = false
    /// When the last tap was released, while a second press can still make it a double tap.
    private var lastTapReleasedAt: TimeInterval?
    /// When a double tap's second press was released as a tap, starting hands-free listening: a press
    /// within `doubleTapWindow` of it makes a triple tap.
    private var handsFreeTapReleasedAt: TimeInterval?
    /// The chat window is open: Escape closes it, a follow-up under way with it.
    public var isChatOpen = false

    /// The two durations are the app's (`minimumHoldDuration`, `doubleTapWindow` in its config).
    public init(hotkey: DictationHotkey, tapMaxDuration: TimeInterval, doubleTapWindow: TimeInterval) {
        self.hotkey = hotkey
        self.tapMaxDuration = tapMaxDuration
        self.doubleTapWindow = doubleTapWindow
    }

    /// Whether a hold or hands-free listening is under way.
    public var isActive: Bool { isHolding || isHandsFree }

    /// A modifier changed at `time`. `isDown` is whether the hotkey's modifier flag is now set.
    public mutating func modifierChanged(keyCode: UInt16, isDown: Bool, at time: TimeInterval) -> Action? {
        guard keyCode == hotkey.keyCode else { return nil }
        if isDown {
            guard !isHolding else { return nil }
            isHolding = true
            holdIsOver = false
            pressedAt = time
            if isHandsFree {
                isHandsFree = false
                holdIsOver = true
                if let tap = handsFreeTapReleasedAt, time - tap <= doubleTapWindow {
                    handsFreeTapReleasedAt = nil
                    return .showHistory
                }
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
            handsFreeTapReleasedAt = time
            return .listenHandsFree
        }
        lastTapReleasedAt = isTap ? time : nil
        return .finish
    }

    /// Whether a key-down of `keyCode` belongs to the gesture, and so must not reach the app in front:
    /// Space while a hold or hands-free listening is under way, Escape while listening hands-free, and
    /// Escape while the chat window is open.
    public func owns(keyCode: UInt16) -> Bool {
        if isChatOpen, keyCode == Self.cancelKeyCode { return true }
        if isHandsFree { return keyCode == Self.toggleKeyCode || keyCode == Self.cancelKeyCode }
        return isHolding && !holdIsOver && keyCode == Self.toggleKeyCode
    }

    /// A non-modifier key was pressed somewhere; `isRepeat` for its auto-repeat.
    public mutating func keyPressed(keyCode: UInt16, isRepeat: Bool) -> Action? {
        // fn released from a tap comes with the Globe key's own key-down: that is the hotkey, not typing.
        if hotkey == .function && keyCode == DictationHotkey.globeKeyCode { return nil }
        // Typing between two taps makes them no double (or triple) tap.
        lastTapReleasedAt = nil
        handsFreeTapReleasedAt = nil
        // Escape closes the chat window even during a follow-up, which closing it cancels; a hold's
        // key-up is then swallowed.
        if isChatOpen, keyCode == Self.cancelKeyCode {
            isHandsFree = false
            if isHolding { holdIsOver = true }
            return isRepeat ? nil : .closeChat
        }
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

    /// The dictation ended without the hotkey (length cap, failure, Escape, the menu), or a double
    /// tap's release found no dictation listening: hands-free listening is over, so the next press
    /// starts afresh and Space and Escape reach the app again.
    public mutating func dictationEnded() {
        isHandsFree = false
    }
}
