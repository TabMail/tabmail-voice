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

/// Pure push-to-talk recogniser: turns raw modifier/key events into start / finish / cancel.
///
/// - Pressing the hotkey starts a hold.
/// - Releasing it finishes the hold.
/// - Pressing any other key during the hold means the user is typing a shortcut
///   (e.g. ⌥-letter), so the hold is cancelled and nothing is inserted.
struct PushToTalkGesture: Sendable {
    enum Action: Equatable, Sendable {
        case start
        case finish
        case cancel
    }

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

    /// A non-modifier key was pressed somewhere.
    mutating func otherKeyPressed() -> Action? {
        guard isHolding, !cancelledDuringHold else { return nil }
        cancelledDuringHold = true
        return .cancel
    }
}
