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

/// What the speech is for: text to insert (a hold), or a request for the agent to carry out (a
/// double tap).
enum DictationMode: Equatable, Sendable {
    case dictation
    case agent
}

/// Pure push-to-talk recogniser: turns raw modifier/key events into start / finish / cancel.
///
/// - Pressing the hotkey starts a dictation; releasing it finishes the hold.
/// - A quick tap followed by another press within `doubleTapWindow` starts agent mode instead. Held,
///   that second press finishes on release like a dictation; tapped, agent mode keeps listening
///   hands-free until the hotkey is pressed again.
/// - Pressing any other key during a hold, or while agent mode listens hands-free, means the user is
///   typing (e.g. a ⌥-letter shortcut), so it is cancelled and nothing is inserted.
///
/// Times are seconds on one monotonic clock (`NSEvent.timestamp`).
struct PushToTalkGesture: Sendable {
    enum Action: Equatable, Sendable {
        case start(DictationMode)
        case finish
        case cancel
    }

    let hotkey: DictationHotkey
    /// A press released within this long is a tap: it starts no dictation (the controller discards
    /// it unseen), but it can be the first half of a double tap.
    let tapMaxDuration: TimeInterval
    /// A second press this soon after a tap's release makes a double tap.
    let doubleTapWindow: TimeInterval
    private(set) var isHolding = false
    /// Agent mode is listening without the key held; the next press finishes it.
    private(set) var isHandsFree = false
    /// Set when a chord cancelled the hold; the eventual key-up must then be swallowed.
    private var cancelledDuringHold = false
    /// The press that ended hands-free listening: its release is swallowed.
    private var releaseEndsNothing = false
    private var pressedAt: TimeInterval = 0
    private var pressIsAgent = false
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
            cancelledDuringHold = false
            pressedAt = time
            if isHandsFree {
                isHandsFree = false
                releaseEndsNothing = true
                return .finish
            }
            if let tap = lastTapReleasedAt, time - tap <= doubleTapWindow {
                lastTapReleasedAt = nil
                pressIsAgent = true
                return .start(.agent)
            }
            pressIsAgent = false
            return .start(.dictation)
        }
        guard isHolding else { return nil }
        isHolding = false
        if releaseEndsNothing {
            releaseEndsNothing = false
            return nil
        }
        if cancelledDuringHold {
            cancelledDuringHold = false
            return nil
        }
        let isTap = time - pressedAt < tapMaxDuration
        if pressIsAgent {
            pressIsAgent = false
            if isTap {
                isHandsFree = true
                return nil
            }
            return .finish
        }
        lastTapReleasedAt = isTap ? time : nil
        return .finish
    }

    /// A non-modifier key was pressed somewhere.
    mutating func otherKeyPressed() -> Action? {
        lastTapReleasedAt = nil
        if isHandsFree {
            isHandsFree = false
            return .cancel
        }
        guard isHolding, !cancelledDuringHold else { return nil }
        cancelledDuringHold = true
        return .cancel
    }

    /// The dictation ended on its own (finished at the length cap, failed, or was cancelled from the
    /// menu): hands-free listening is over, so the next press starts afresh.
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
