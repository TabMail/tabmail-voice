// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon.HIToolbox
import Testing
@testable import TabMailVoice

struct PushToTalkGestureTests {
    private let hotkeyCode = DictationHotkey.rightOption.keyCode
    private let leftOption = UInt16(kVK_Option)
    private let space = UInt16(kVK_Space)
    private let letterA = UInt16(kVK_ANSI_A)

    private func makeGesture(_ hotkey: DictationHotkey = .rightOption) -> PushToTalkGesture {
        PushToTalkGesture(hotkey: hotkey)
    }

    /// Presses the hotkey and releases it; returns both actions.
    private func press(_ gesture: inout PushToTalkGesture) -> (PushToTalkGesture.Action?, PushToTalkGesture.Action?) {
        (gesture.modifierChanged(keyCode: hotkeyCode, isDown: true), gesture.modifierChanged(keyCode: hotkeyCode, isDown: false))
    }

    @Test func pressThenReleaseStartsThenFinishes() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true) == .start)
        #expect(gesture.isHolding)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == .finish)
        #expect(!gesture.isHolding)
    }

    @Test func otherModifiersAreIgnored() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: true) == nil)
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: false) == nil)
        #expect(!gesture.isHolding)
    }

    @Test func repeatedDownWhileHoldingDoesNotRestart() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true) == nil)
    }

    @Test func releaseWithoutPressIsIgnored() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == nil)
    }

    /// ⌥-letter chords must not dictate: a key during the hold cancels, and the release
    /// that follows must not finish (which would paste).
    @Test func chordCancelsAndSwallowsTheRelease() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        #expect(!gesture.owns(keyCode: letterA))
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == .cancel)
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == nil)
        // The next hold works normally.
        #expect(press(&gesture) == (.start, .finish))
    }

    @Test func typingWhileNotHoldingDoesNothing() {
        var gesture = makeGesture()
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == nil)
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == nil)
    }

    @Test func functionHotkeyMatchesItsOwnKeyCode() {
        var gesture = makeGesture(.function)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true) == nil)
        #expect(gesture.modifierChanged(keyCode: UInt16(kVK_Function), isDown: true) == .start)
    }

    // MARK: Space → agent mode

    /// Space during the hold switches the mode, each press once, and the hold still finishes on
    /// release: the switch is no chord.
    @Test func spaceDuringTheHoldTogglesTheModeAndTheHoldStillFinishes() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        #expect(gesture.owns(keyCode: space))
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == .toggleMode)
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == .toggleMode)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == .finish)
    }

    /// Holding Space down switches once: its auto-repeat is still kept from the app, and switches nothing.
    @Test func spaceAutoRepeatIsOwnedButDoesNotToggle() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == .toggleMode)
        #expect(gesture.owns(keyCode: space))
        #expect(gesture.keyPressed(keyCode: space, isRepeat: true) == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == .finish)
    }

    /// Space is the app's again once no hold is under way, or once a chord cancelled the hold.
    @Test func spaceIsOwnedOnlyDuringALiveHold() {
        var gesture = makeGesture()
        #expect(!gesture.owns(keyCode: space))
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        _ = gesture.keyPressed(keyCode: letterA, isRepeat: false)
        #expect(!gesture.owns(keyCode: space))
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == nil)
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: false)
        #expect(!gesture.owns(keyCode: space))
    }

    /// Another key after Space still means typing: the hold is cancelled.
    @Test func aChordAfterTheToggleCancels() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        _ = gesture.keyPressed(keyCode: space, isRepeat: false)
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == .cancel)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == nil)
    }
}
