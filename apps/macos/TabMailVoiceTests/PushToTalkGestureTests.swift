// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon.HIToolbox
import Testing
@testable import TabMailVoice

struct PushToTalkGestureTests {
    private let hotkeyCode = DictationHotkey.rightOption.keyCode
    private let leftOption = UInt16(kVK_Option)
    /// Timings written out rather than read from `DictationConfig`, so each case sits clearly on one
    /// side of its boundary. Binary fractions, so the boundary cases compare exactly.
    private let tapMax: TimeInterval = 0.25
    private let window: TimeInterval = 0.5

    private func makeGesture(_ hotkey: DictationHotkey = .rightOption) -> PushToTalkGesture {
        PushToTalkGesture(hotkey: hotkey, tapMaxDuration: tapMax, doubleTapWindow: window)
    }

    /// Presses the hotkey at `down` and releases it at `up`; returns both actions.
    private func press(_ gesture: inout PushToTalkGesture, at down: TimeInterval, until up: TimeInterval) -> (PushToTalkGesture.Action?, PushToTalkGesture.Action?) {
        (gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: down), gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: up))
    }

    @Test func pressThenReleaseStartsThenFinishes() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 10) == .start(.dictation))
        #expect(gesture.isHolding)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 11) == .finish)
        #expect(!gesture.isHolding)
        #expect(!gesture.isActive)
    }

    @Test func otherModifiersAreIgnored() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: true, at: 10) == nil)
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: false, at: 10.1) == nil)
        #expect(!gesture.isHolding)
    }

    @Test func repeatedDownWhileHoldingDoesNotRestart() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 10)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 10.1) == nil)
    }

    @Test func releaseWithoutPressIsIgnored() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 10) == nil)
    }

    /// ⌥-letter chords must not dictate: a key during the hold cancels, and the release
    /// that follows must not finish (which would paste).
    @Test func chordCancelsAndSwallowsTheRelease() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 10)
        #expect(gesture.otherKeyPressed() == .cancel)
        #expect(gesture.otherKeyPressed() == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 10.1) == nil)
        // The next hold works normally, and the chord's short press was no tap.
        #expect(press(&gesture, at: 10.2, until: 11) == (.start(.dictation), .finish))
    }

    @Test func typingWhileNotHoldingDoesNothing() {
        var gesture = makeGesture()
        #expect(gesture.otherKeyPressed() == nil)
    }

    @Test func functionHotkeyMatchesItsOwnKeyCode() {
        var gesture = makeGesture(.function)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 10) == nil)
        #expect(gesture.modifierChanged(keyCode: UInt16(kVK_Function), isDown: true, at: 10) == .start(.dictation))
    }

    // MARK: Double tap → agent mode

    /// Tap, then press and hold: agent mode, finished on release like a dictation.
    @Test func aTapThenAHoldIsAgentModeFinishedOnRelease() {
        var gesture = makeGesture()
        #expect(press(&gesture, at: 10, until: 10.1) == (.start(.dictation), .finish))
        #expect(press(&gesture, at: 10.3, until: 12) == (.start(.agent), .finish))
        #expect(!gesture.isActive)
    }

    /// Tap, tap: agent mode listens hands-free; the next press finishes it and its release does nothing.
    @Test func aDoubleTapListensHandsFreeUntilTheNextPress() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 10, until: 10.1)
        #expect(press(&gesture, at: 10.3, until: 10.4) == (.start(.agent), nil))
        #expect(gesture.isHandsFree)
        #expect(gesture.isActive)
        #expect(press(&gesture, at: 15, until: 15.1) == (.finish, nil))
        #expect(!gesture.isActive)
        // The stopping press was a tap too, but not the first half of a double tap.
        #expect(press(&gesture, at: 15.3, until: 16) == (.start(.dictation), .finish))
    }

    @Test func aSecondPressAfterTheWindowIsADictation() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 9.875, until: 10)
        #expect(press(&gesture, at: 10 + window + 0.125, until: 11) == (.start(.dictation), .finish))
    }

    @Test func aSecondPressAtTheEdgeOfTheWindowIsAgentMode() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 9.875, until: 10)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 10 + window) == .start(.agent))
    }

    /// Only a tap can start a double tap: a press held for the tap limit or longer was a dictation.
    @Test func aPressAfterAHeldDictationIsADictation() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 10, until: 10 + tapMax)
        #expect(press(&gesture, at: 10 + tapMax + 0.1, until: 11) == (.start(.dictation), .finish))
    }

    @Test func typingBetweenTheTapsIsNoDoubleTap() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 10, until: 10.1)
        #expect(gesture.otherKeyPressed() == nil)
        #expect(press(&gesture, at: 10.2, until: 11) == (.start(.dictation), .finish))
    }

    @Test func typingWhileListeningHandsFreeCancels() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 10, until: 10.1)
        _ = press(&gesture, at: 10.2, until: 10.3)
        #expect(gesture.otherKeyPressed() == .cancel)
        #expect(!gesture.isActive)
        #expect(gesture.otherKeyPressed() == nil)
        #expect(press(&gesture, at: 12, until: 13) == (.start(.dictation), .finish))
    }

    /// A chord during agent mode's held press cancels it and does not leave it listening hands-free.
    @Test func aChordDuringTheAgentPressCancelsIt() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 10, until: 10.1)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 10.2) == .start(.agent))
        #expect(gesture.otherKeyPressed() == .cancel)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 10.25) == nil)
        #expect(!gesture.isActive)
    }

    /// The dictation ended without the hotkey (length cap, failure): the next press starts afresh
    /// instead of finishing a dictation that is already over.
    @Test func aDictationEndingOnItsOwnEndsHandsFreeListening() {
        var gesture = makeGesture()
        _ = press(&gesture, at: 10, until: 10.1)
        _ = press(&gesture, at: 10.2, until: 10.3)
        gesture.dictationEnded()
        #expect(!gesture.isActive)
        #expect(press(&gesture, at: 20, until: 21) == (.start(.dictation), .finish))
    }
}
