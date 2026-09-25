// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon.HIToolbox
import Testing
@testable import TabMail

struct PushToTalkGestureTests {
    private let hotkeyCode = DictationHotkey.rightOption.keyCode
    private let leftOption = UInt16(kVK_Option)

    @Test func pressThenReleaseStartsThenFinishes() {
        var gesture = PushToTalkGesture(hotkey: .rightOption)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true) == .start)
        #expect(gesture.isHolding)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == .finish)
        #expect(!gesture.isHolding)
    }

    @Test func otherModifiersAreIgnored() {
        var gesture = PushToTalkGesture(hotkey: .rightOption)
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: true) == nil)
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: false) == nil)
        #expect(!gesture.isHolding)
    }

    @Test func repeatedDownWhileHoldingDoesNotRestart() {
        var gesture = PushToTalkGesture(hotkey: .rightOption)
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true) == nil)
    }

    @Test func releaseWithoutPressIsIgnored() {
        var gesture = PushToTalkGesture(hotkey: .rightOption)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == nil)
    }

    /// ⌥-letter chords must not dictate: a key during the hold cancels, and the release
    /// that follows must not finish (which would paste).
    @Test func chordCancelsAndSwallowsTheRelease() {
        var gesture = PushToTalkGesture(hotkey: .rightOption)
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true)
        #expect(gesture.otherKeyPressed() == .cancel)
        #expect(gesture.otherKeyPressed() == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == nil)
        // The next hold works normally.
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true) == .start)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false) == .finish)
    }

    @Test func typingWhileNotHoldingDoesNothing() {
        var gesture = PushToTalkGesture(hotkey: .rightOption)
        #expect(gesture.otherKeyPressed() == nil)
    }

    @Test func functionHotkeyMatchesItsOwnKeyCode() {
        var gesture = PushToTalkGesture(hotkey: .function)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true) == nil)
        #expect(gesture.modifierChanged(keyCode: UInt16(kVK_Function), isDown: true) == .start)
    }
}
