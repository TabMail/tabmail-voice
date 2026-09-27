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
    private let escape = UInt16(kVK_Escape)
    /// For the tests of holds: a second a reading, so every press is a deliberate hold, and none
    /// makes a double tap.
    private let clock = Ticker()

    private func makeGesture(_ hotkey: DictationHotkey = .rightOption) -> PushToTalkGesture {
        PushToTalkGesture(hotkey: hotkey)
    }

    /// Presses the hotkey and releases it; returns both actions.
    private func press(_ gesture: inout PushToTalkGesture) -> (PushToTalkGesture.Action?, PushToTalkGesture.Action?) {
        (gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick()), gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick()))
    }

    @Test func pressThenReleaseStartsThenFinishes() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick()) == .start)
        #expect(gesture.isHolding)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick()) == .finish)
        #expect(!gesture.isHolding)
    }

    @Test func otherModifiersAreIgnored() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: true, at: clock.tick()) == nil)
        #expect(gesture.modifierChanged(keyCode: leftOption, isDown: false, at: clock.tick()) == nil)
        #expect(!gesture.isHolding)
    }

    @Test func repeatedDownWhileHoldingDoesNotRestart() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick())
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick()) == nil)
    }

    @Test func releaseWithoutPressIsIgnored() {
        var gesture = makeGesture()
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick()) == nil)
    }

    /// ⌥-letter chords must not dictate: a key during the hold cancels, and the release
    /// that follows must not finish (which would paste).
    @Test func chordCancelsAndSwallowsTheRelease() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick())
        #expect(!gesture.owns(keyCode: letterA))
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == .cancel)
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick()) == nil)
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
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick()) == nil)
        #expect(gesture.modifierChanged(keyCode: UInt16(kVK_Function), isDown: true, at: clock.tick()) == .start)
    }

    // MARK: Space → agent mode

    /// Space during the hold switches the mode, each press once, and the hold still finishes on
    /// release: the switch is no chord.
    @Test func spaceDuringTheHoldTogglesTheModeAndTheHoldStillFinishes() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick())
        #expect(gesture.owns(keyCode: space))
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == .toggleMode)
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == .toggleMode)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick()) == .finish)
    }

    /// Holding Space down switches once: its auto-repeat is still kept from the app, and switches nothing.
    @Test func spaceAutoRepeatIsOwnedButDoesNotToggle() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick())
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == .toggleMode)
        #expect(gesture.owns(keyCode: space))
        #expect(gesture.keyPressed(keyCode: space, isRepeat: true) == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick()) == .finish)
    }

    /// Space is the app's again once no hold is under way, or once a chord cancelled the hold.
    @Test func spaceIsOwnedOnlyDuringALiveHold() {
        var gesture = makeGesture()
        #expect(!gesture.owns(keyCode: space))
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick())
        _ = gesture.keyPressed(keyCode: letterA, isRepeat: false)
        #expect(!gesture.owns(keyCode: space))
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == nil)
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick())
        #expect(!gesture.owns(keyCode: space))
    }

    /// Another key after Space still means typing: the hold is cancelled.
    @Test func aChordAfterTheToggleCancels() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick())
        _ = gesture.keyPressed(keyCode: space, isRepeat: false)
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == .cancel)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: clock.tick()) == nil)
    }

    // MARK: Double tap → hands-free

    /// A tap, then a press, then a release: times in seconds.
    private func doubleTap(_ gesture: inout PushToTalkGesture, secondReleaseAt: TimeInterval = 0.45) -> [PushToTalkGesture.Action?] {
        [
            gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0),
            gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 0.1),
            gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0.4),
            gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: secondReleaseAt),
        ]
    }

    /// Tapped twice, the dictation goes on without the key, until the hotkey is tapped again; that
    /// press's release does nothing.
    @Test func aDoubleTapListensHandsFreeUntilTheNextTap() {
        var gesture = makeGesture()
        #expect(doubleTap(&gesture) == [.start, .finish, .startHandsFree, nil])
        #expect(gesture.isHandsFree && gesture.isActive)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 5) == .finish)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 5.1) == nil)
        #expect(!gesture.isActive)
        // The next press is an ordinary hold again.
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 8) == .start)
    }

    /// Held, the double tap's second press is an ordinary hold: its release finishes.
    @Test func aDoubleTapHeldFinishesOnRelease() {
        var gesture = makeGesture()
        #expect(doubleTap(&gesture, secondReleaseAt: 3) == [.start, .finish, .startHandsFree, .finish])
        #expect(!gesture.isActive)
    }

    /// Only a tap followed soon by a press is a double tap: not a press after the window, and not a
    /// press after a hold.
    @Test func onlyATapFollowedWithinTheWindowIsADoubleTap() {
        let window = DictationConfig.doubleTapWindow.timeInterval
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0)
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 0.1)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0.1 + window + 0.05) == .start)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 3) == .finish)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 3.1) == .start)
        #expect(!gesture.isHandsFree)
    }

    /// Typing between the two taps: no double tap.
    @Test func aKeyBetweenTheTapsBreaksTheDoubleTap() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0)
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 0.1)
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0.3) == .start)
    }

    /// With fn as the hotkey, the Globe key's own key-down (sent as each tap is released) is the
    /// hotkey, not typing: the double tap still counts. A real key between the taps still breaks it.
    @Test func theGlobeKeysKeyDownAfterAnFnTapIsNoTyping() {
        let fn = DictationHotkey.function.keyCode
        for (between, expected) in [(DictationHotkey.globeKeyCode, PushToTalkGesture.Action.startHandsFree), (letterA, .start)] {
            var gesture = makeGesture(.function)
            _ = gesture.modifierChanged(keyCode: fn, isDown: true, at: 0)
            _ = gesture.modifierChanged(keyCode: fn, isDown: false, at: 0.1)
            #expect(gesture.keyPressed(keyCode: between, isRepeat: false) == nil)
            #expect(gesture.modifierChanged(keyCode: fn, isDown: true, at: 0.3) == expected)
        }
    }

    /// Hands-free, Space switches the mode and Escape cancels, both kept from the app; any other key
    /// reaches it and changes nothing.
    @Test func handsFreeSpaceTogglesAndEscapeCancels() {
        var gesture = makeGesture()
        _ = doubleTap(&gesture)
        #expect(gesture.owns(keyCode: space) && gesture.owns(keyCode: escape))
        #expect(!gesture.owns(keyCode: letterA))
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == nil)
        #expect(gesture.isHandsFree)
        #expect(gesture.keyPressed(keyCode: space, isRepeat: false) == .toggleMode)
        #expect(gesture.keyPressed(keyCode: space, isRepeat: true) == nil)
        #expect(gesture.keyPressed(keyCode: escape, isRepeat: false) == .cancel)
        #expect(!gesture.isActive)
        #expect(!gesture.owns(keyCode: space) && !gesture.owns(keyCode: escape))
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 5) == .start)
    }

    /// During a hold, Escape is a key like any other: it cancels and reaches the app.
    @Test func escapeDuringAHoldCancelsLikeAnyKey() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: clock.tick())
        #expect(!gesture.owns(keyCode: escape))
        #expect(gesture.keyPressed(keyCode: escape, isRepeat: false) == .cancel)
    }

    /// A chord while the double tap's second press is held cancels it, and nothing listens on.
    @Test func aChordDuringTheSecondPressCancelsIt() {
        var gesture = makeGesture()
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0)
        _ = gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 0.1)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 0.3) == .startHandsFree)
        #expect(gesture.keyPressed(keyCode: letterA, isRepeat: false) == .cancel)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: false, at: 0.35) == nil)
        #expect(!gesture.isActive)
    }

    /// The dictation ended on its own (length cap, failure): Space and Escape are the app's again, and
    /// the next press starts afresh.
    @Test func aDictationEndedStopsHandsFreeListening() {
        var gesture = makeGesture()
        _ = doubleTap(&gesture)
        gesture.dictationEnded()
        #expect(!gesture.isActive)
        #expect(!gesture.owns(keyCode: space) && !gesture.owns(keyCode: escape))
        #expect(gesture.keyPressed(keyCode: escape, isRepeat: false) == nil)
        #expect(gesture.modifierChanged(keyCode: hotkeyCode, isDown: true, at: 5) == .start)
    }
}

