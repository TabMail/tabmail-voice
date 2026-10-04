// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import CVoiceCore
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
        case startAgent
        case startAgentHandsFree
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
    public let tapMaxDuration: TimeInterval
    public let doubleTapWindow: TimeInterval
    private var state = VoiceGestureState()
    public var isHolding: Bool { state.holding != 0 }
    public var isHandsFree: Bool { state.handsFree != 0 }
    public var isActive: Bool { isHolding || isHandsFree }
    public var isChatOpen: Bool {
        get { state.chatOpen != 0 }
        set { state.chatOpen = newValue ? 1 : 0 }
    }

    public init(hotkey: DictationHotkey, tapMaxDuration: TimeInterval, doubleTapWindow: TimeInterval) {
        self.hotkey = hotkey
        self.tapMaxDuration = tapMaxDuration
        self.doubleTapWindow = doubleTapWindow
        state.tapMaxDuration = tapMaxDuration
        state.doubleTapWindow = doubleTapWindow
    }

    public mutating func modifierChanged(keyCode: UInt16, isDown: Bool, at time: TimeInterval, agent: Bool = false) -> Action? {
        guard keyCode == hotkey.keyCode else { return nil }
        return Self.action(voice_core_gesture_modifier(&state, isDown ? 1 : 0, time, agent ? 1 : 0))
    }

    public func owns(keyCode: UInt16) -> Bool {
        withUnsafePointer(to: state) { voice_core_gesture_owns($0, Self.normalized(keyCode)) != 0 }
    }

    public mutating func keyPressed(keyCode: UInt16, isRepeat: Bool) -> Action? {
        // The synthetic Globe key-down belongs to fn, not to typing between taps.
        if hotkey == .function && keyCode == DictationHotkey.globeKeyCode { return nil }
        return Self.action(voice_core_gesture_key(&state, Self.normalized(keyCode), isRepeat ? 1 : 0))
    }

    public mutating func dictationEnded() { voice_core_gesture_ended(&state) }

    private static func normalized(_ keyCode: UInt16) -> UInt32 {
        keyCode == toggleKeyCode ? 1 : keyCode == cancelKeyCode ? 2 : 0
    }

    private static func action(_ value: UInt32) -> Action? {
        switch value {
        case UInt32(VoiceGestureStart.rawValue): .start
        case UInt32(VoiceGestureStartHandsFree.rawValue): .startHandsFree
        case UInt32(VoiceGestureStartAgent.rawValue): .startAgent
        case UInt32(VoiceGestureStartAgentHandsFree.rawValue): .startAgentHandsFree
        case UInt32(VoiceGestureListenHandsFree.rawValue): .listenHandsFree
        case UInt32(VoiceGestureFinish.rawValue): .finish
        case UInt32(VoiceGestureCancel.rawValue): .cancel
        case UInt32(VoiceGestureToggleMode.rawValue): .toggleMode
        case UInt32(VoiceGestureCloseChat.rawValue): .closeChat
        case UInt32(VoiceGestureShowHistory.rawValue): .showHistory
        default: nil
        }
    }
}
