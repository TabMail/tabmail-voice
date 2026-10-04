// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon.HIToolbox
import CoreGraphics
import Testing
@testable import VoiceHotkeyKit

/// `HotkeyMonitor` fed events directly, with no event tap: which events reach the app in front, and
/// which actions reach the controller. The invariant: only the gesture's own Space (and its
/// auto-repeat and key-up) is kept from the app; every other key reaches it.
@MainActor
struct HotkeyMonitorTests {
    private let space = UInt16(kVK_Space)
    private let letterA = UInt16(kVK_ANSI_A)
    private let rightOption = UInt16(kVK_RightOption)
    private let escape = UInt16(kVK_Escape)
    /// Event times: a second apart, so every press is a hold and none makes a double tap.
    private let clock = Ticker()

    private func gesture(_ hotkey: DictationHotkey) -> PushToTalkGesture {
        PushToTalkGesture(hotkey: hotkey, tapMaxDuration: tapMaxDuration, doubleTapWindow: doubleTapWindow)
    }

    /// A monitor for `hotkey` and the actions it has dispatched so far.
    private func makeMonitor(_ hotkey: DictationHotkey = .rightOption) -> (HotkeyMonitor, Actions) {
        let actions = Actions()
        return (HotkeyMonitor(gesture: gesture(hotkey)) { actions.list.append($0) }, actions)
    }

    /// Actions are dispatched to the main queue after the event is handled: lets them run.
    private func dispatched(_ actions: Actions) async -> [PushToTalkGesture.Action] {
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
        return actions.list
    }

    private func key(_ monitor: HotkeyMonitor, _ type: CGEventType, _ keyCode: UInt16, isRepeat: Bool = false) -> Bool {
        monitor.handle(type, keyCode: keyCode, flags: [], isRepeat: isRepeat, at: clock.tick())
    }

    private func hotkey(_ monitor: HotkeyMonitor, down: Bool, keyCode: UInt16? = nil, flag: CGEventFlags = .maskAlternate, at time: TimeInterval? = nil) -> Bool {
        monitor.handle(.flagsChanged, keyCode: keyCode ?? rightOption, flags: down ? flag : [], isRepeat: false, at: time ?? clock.tick())
    }

    @Test func shiftSelectsAgentOnlyAtTheHotkeyDownEdge() async {
        for hotkey in DictationHotkey.allCases {
            for shift in [UInt16(kVK_Shift), UInt16(kVK_RightShift)] {
                for releaseShiftFirst in [true, false] {
                    let (monitor, actions) = makeMonitor(hotkey)
                    let base: CGEventFlags = hotkey == .function ? .maskSecondaryFn : .maskAlternate
                    #expect(monitor.handle(.flagsChanged, keyCode: shift, flags: .maskShift, isRepeat: false, at: 1))
                    #expect(monitor.handle(.flagsChanged, keyCode: hotkey.keyCode, flags: [base, .maskShift], isRepeat: false, at: 2))
                    if releaseShiftFirst {
                        #expect(monitor.handle(.flagsChanged, keyCode: shift, flags: base, isRepeat: false, at: 3))
                    }
                    #expect(monitor.handle(.flagsChanged, keyCode: hotkey.keyCode, flags: releaseShiftFirst ? [] : .maskShift, isRepeat: false, at: 4))
                    #expect(await dispatched(actions) == [.startAgent, .finish])
                }
            }
        }
        let (monitor, actions) = makeMonitor()
        #expect(hotkey(monitor, down: true))
        #expect(monitor.handle(.flagsChanged, keyCode: UInt16(kVK_Shift), flags: [.maskShift, .maskAlternate], isRepeat: false, at: clock.tick()))
        #expect(hotkey(monitor, down: false))
        #expect(await dispatched(actions) == [.start, .finish])
    }

    @Test func spaceDuringAHoldIsKeptFromTheAppAndSwitchesTheMode() async {
        let (monitor, actions) = makeMonitor()

        #expect(hotkey(monitor, down: true))
        #expect(!key(monitor, .keyDown, space))
        #expect(!key(monitor, .keyDown, space, isRepeat: true))
        #expect(!key(monitor, .keyUp, space))
        #expect(hotkey(monitor, down: false))

        // The auto-repeat is kept from the app but switches nothing.
        #expect(await dispatched(actions) == [.start, .toggleMode, .finish])
    }

    /// Only the key-up of a kept key-down is kept: a stray key-up reaches the app.
    @Test func onlyTheKeptSpacesKeyUpIsKept() {
        let (monitor, _) = makeMonitor()

        #expect(hotkey(monitor, down: true))
        #expect(!key(monitor, .keyDown, space))
        #expect(!key(monitor, .keyUp, space))
        #expect(key(monitor, .keyUp, space))
    }

    /// The hotkey let go before Space: Space's key-up still belongs to the kept key-down.
    @Test func theKeptSpacesKeyUpIsKeptAfterTheHotkeyIsLetGo() {
        let (monitor, _) = makeMonitor()

        #expect(hotkey(monitor, down: true))
        #expect(!key(monitor, .keyDown, space))
        #expect(hotkey(monitor, down: false))
        #expect(!key(monitor, .keyUp, space))
        #expect(key(monitor, .keyUp, space))
    }

    @Test func spaceOutsideAHoldReachesTheApp() async {
        let (monitor, actions) = makeMonitor()

        #expect(key(monitor, .keyDown, space))
        #expect(key(monitor, .keyUp, space))

        #expect(await dispatched(actions).isEmpty)
    }

    /// A chord (⌥-letter) cancels the hold; its keys, and any Space after it, reach the app.
    @Test func aChordCancelsTheHoldAndItsKeysReachTheApp() async {
        let (monitor, actions) = makeMonitor()

        #expect(hotkey(monitor, down: true))
        #expect(key(monitor, .keyDown, letterA))
        #expect(key(monitor, .keyUp, letterA))
        #expect(key(monitor, .keyDown, space))
        #expect(key(monitor, .keyUp, space))
        #expect(hotkey(monitor, down: false))

        #expect(await dispatched(actions) == [.start, .cancel])
    }

    /// Each hotkey is down only while its own modifier flag is set.
    @Test(arguments: [
        (DictationHotkey.rightOption, CGEventFlags.maskAlternate, CGEventFlags.maskSecondaryFn),
        (.function, .maskSecondaryFn, .maskAlternate),
    ])
    func eachHotkeyReadsItsOwnModifierFlag(hotkey: DictationHotkey, flag: CGEventFlags, otherFlag: CGEventFlags) async {
        let (monitor, actions) = makeMonitor(hotkey)

        #expect(self.hotkey(monitor, down: true, keyCode: hotkey.keyCode, flag: otherFlag))
        #expect(await dispatched(actions).isEmpty)
        #expect(self.hotkey(monitor, down: true, keyCode: hotkey.keyCode, flag: flag))
        #expect(await dispatched(actions) == [.start])
    }

    /// An fn double tap as macOS delivers it: each tap's release is followed at once by a key-down and
    /// key-up of the Globe key's own code (recorded on a MacBook keyboard, 2026-09-27, with the Globe
    /// action on Do Nothing). That key-down is the hotkey, not typing, so the second press still
    /// starts hands-free listening, which its release keeps; both reach the app, as before. Hands-free
    /// listening then goes on past the second tap's Globe key: Space switches the mode and is kept
    /// from the app, and an fn press (finishing at the press) or Escape ends it, after which Space
    /// reaches the app again.
    @Test(arguments: [false, true])
    func anFnDoubleTapIsHandsFreeDespiteTheGlobeKeysOwnKeyDown(endsWithEscape: Bool) async {
        let (monitor, actions) = makeMonitor(.function)
        let fn = DictationHotkey.function.keyCode
        // The recorded code itself, not the helper's constant, so a wrong constant fails here.
        let globe = UInt16(0xB3)
        func event(_ type: CGEventType, _ keyCode: UInt16, _ flags: CGEventFlags, at time: TimeInterval) -> Bool {
            monitor.handle(type, keyCode: keyCode, flags: flags, isRepeat: false, at: time)
        }

        #expect(event(.flagsChanged, fn, .maskSecondaryFn, at: 0))
        #expect(event(.flagsChanged, fn, [], at: 0.056))
        #expect(event(.keyDown, globe, [], at: 0.059))
        #expect(event(.keyUp, globe, [], at: 0.059))
        #expect(event(.flagsChanged, fn, .maskSecondaryFn, at: 0.182))
        #expect(event(.flagsChanged, fn, [], at: 0.293))
        #expect(event(.keyDown, globe, [], at: 0.293))
        #expect(event(.keyUp, globe, [], at: 0.293))
        #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree])

        #expect(!event(.keyDown, space, [], at: 1))
        #expect(!event(.keyUp, space, [], at: 1.1))
        #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree, .toggleMode])
        if endsWithEscape {
            #expect(!event(.keyDown, escape, [], at: 2))
            #expect(!event(.keyUp, escape, [], at: 2.1))
            #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree, .toggleMode, .cancel])
        } else {
            #expect(event(.flagsChanged, fn, .maskSecondaryFn, at: 2))
            #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree, .toggleMode, .finish])
            #expect(event(.flagsChanged, fn, [], at: 2.1))
            #expect(event(.keyDown, globe, [], at: 2.103))
            #expect(event(.keyUp, globe, [], at: 2.103))
            #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree, .toggleMode, .finish])
        }
        #expect(event(.keyDown, space, [], at: 3))
        #expect(event(.keyUp, space, [], at: 3.1))
    }

    /// macOS switched the tap off: the event goes on, and nothing reaches the controller.
    @Test(arguments: [CGEventType.tapDisabledByTimeout, .tapDisabledByUserInput])
    func aDisabledTapPassesTheEventOn(type: CGEventType) async {
        let (monitor, actions) = makeMonitor()

        #expect(monitor.handle(type, keyCode: 0, flags: [], isRepeat: false, at: clock.tick()))
        #expect(await dispatched(actions).isEmpty)
    }

    /// Uninstalling forgets the kept key-downs: their key-ups, delivered later, reach the app.
    @Test func uninstallingForgetsTheKeptKeys() {
        let (monitor, _) = makeMonitor()
        #expect(hotkey(monitor, down: true))
        #expect(!key(monitor, .keyDown, space))

        monitor.uninstall()

        #expect(key(monitor, .keyUp, space))
    }

    /// Tapped twice: listening hands-free, the app loses only Space and Escape (their key-ups too);
    /// Escape cancels, and then both reach the app again.
    @Test func handsFreeKeepsOnlySpaceAndEscapeFromTheApp() async {
        let (monitor, actions) = makeMonitor()
        for (down, time) in [(true, 0.0), (false, 0.1), (true, 0.4), (false, 0.45)] {
            #expect(hotkey(monitor, down: down, at: time))
        }

        #expect(key(monitor, .keyDown, letterA))
        #expect(key(monitor, .keyUp, letterA))
        #expect(!key(monitor, .keyDown, space))
        #expect(!key(monitor, .keyUp, space))
        #expect(!key(monitor, .keyDown, escape))
        #expect(!key(monitor, .keyUp, escape))
        #expect(key(monitor, .keyDown, space))
        #expect(key(monitor, .keyDown, escape))

        #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree, .toggleMode, .cancel])
    }

    /// The dictation ended without the hotkey: Space reaches the app, and the next press starts a hold.
    @Test func aDictationEndedGivesSpaceBackToTheApp() async {
        let (monitor, actions) = makeMonitor()
        for (down, time) in [(true, 0.0), (false, 0.1), (true, 0.4), (false, 0.45)] {
            #expect(hotkey(monitor, down: down, at: time))
        }
        monitor.dictationEnded()

        #expect(key(monitor, .keyDown, space))
        #expect(hotkey(monitor, down: true))
        #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree, .start])
    }

    /// Changing the hotkey while listening hands-free cancels the dictation, as during a hold.
    @Test func changingTheHotkeyCancelsHandsFreeListening() async {
        let (monitor, actions) = makeMonitor()
        for (down, time) in [(true, 0.0), (false, 0.1), (true, 0.4), (false, 0.45)] {
            #expect(hotkey(monitor, down: down, at: time))
        }
        #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree])
        monitor.configure(gesture(.function))

        #expect(key(monitor, .keyDown, space))
        #expect(await dispatched(actions) == [.start, .finish, .startHandsFree, .listenHandsFree, .cancel])
    }

    /// With the chat window open, Escape (and its key-up) is kept from the app and closes it; closed,
    /// Escape reaches the app again. A hotkey change keeps the window's Escape.
    @Test func escapeClosesTheOpenChatWindow() async {
        let (monitor, actions) = makeMonitor()
        monitor.setChatOpen(true)
        monitor.configure(gesture(.function))

        #expect(key(monitor, .keyDown, letterA))
        #expect(!key(monitor, .keyDown, escape))
        #expect(!key(monitor, .keyUp, escape))
        monitor.setChatOpen(false)
        #expect(key(monitor, .keyDown, escape))
        #expect(key(monitor, .keyUp, escape))

        #expect(await dispatched(actions) == [.closeChat])
    }
}


/// What the monitor dispatched, in order.
@MainActor
private final class Actions {
    var list: [PushToTalkGesture.Action] = []
}
