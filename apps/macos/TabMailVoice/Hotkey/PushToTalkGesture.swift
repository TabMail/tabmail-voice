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
///   deliberate is discarded by the controller, unseen.
/// - Space during the hold switches between dictation and agent mode. The monitor keeps that Space
///   from the app in front (`owns(keyCode:)`); its auto-repeat switches nothing.
/// - Pressing any other key during a hold means the user is typing (e.g. a ⌥-letter shortcut), so it
///   is cancelled and nothing is inserted.
struct PushToTalkGesture: Sendable {
    enum Action: Equatable, Sendable {
        case start
        case finish
        case cancel
        case toggleMode
    }

    static let toggleKeyCode = UInt16(kVK_Space)

    let hotkey: DictationHotkey
    private(set) var isHolding = false
    /// Set when a chord cancelled the hold; the eventual key-up must then be swallowed.
    private var cancelledDuringHold = false

    init(hotkey: DictationHotkey) {
        self.hotkey = hotkey
    }

    /// A modifier changed. `isDown` is whether the hotkey's modifier flag is now set.
    mutating func modifierChanged(keyCode: UInt16, isDown: Bool) -> Action? {
        guard keyCode == hotkey.keyCode else { return nil }
        if isDown {
            guard !isHolding else { return nil }
            isHolding = true
            cancelledDuringHold = false
            return .start
        }
        guard isHolding else { return nil }
        isHolding = false
        if cancelledDuringHold {
            cancelledDuringHold = false
            return nil
        }
        return .finish
    }

    /// Whether a key-down of `keyCode` belongs to the gesture, and so must not reach the app in front:
    /// Space while a hold is under way.
    func owns(keyCode: UInt16) -> Bool {
        isHolding && !cancelledDuringHold && keyCode == Self.toggleKeyCode
    }

    /// A non-modifier key was pressed somewhere; `isRepeat` for its auto-repeat.
    mutating func keyPressed(keyCode: UInt16, isRepeat: Bool) -> Action? {
        guard isHolding, !cancelledDuringHold else { return nil }
        if keyCode == Self.toggleKeyCode { return isRepeat ? nil : .toggleMode }
        cancelledDuringHold = true
        return .cancel
    }
}
