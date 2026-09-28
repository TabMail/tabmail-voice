// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Carbon.HIToolbox
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceHotkeyKit

/// `HotkeyService` over its wire, with no event tap: a request the app sends reaches the monitor.
@MainActor
struct HotkeyServiceTests {
    final class Lines: Sendable {
        private let lines = OSAllocatedUnfairLock<[JSON]>(initialState: [])
        var all: [JSON] { lines.withLock { $0 } }
        func append(_ data: Data) {
            let value = try! JSONDecoder().decode(JSON.self, from: data)
            lines.withLock { $0.append(value) }
        }
    }

    private let rightOption = UInt16(kVK_RightOption)
    private let space = UInt16(kVK_Space)
    private let escape = UInt16(kVK_Escape)

    /// A dictation that ended without the hotkey (the length cap, a failure, the menu) ends hands-free
    /// listening: once the app says so, Space reaches the app in front again. The gesture's actions
    /// reach the app as events, in order, each named as the app reads it.
    @Test func dictationEndedEndsHandsFreeListening() async {
        let lines = Lines()
        let channel = HelperChannel(output: { lines.append($0) })
        let monitor = HotkeyService.register(on: channel)
        monitor.configure(PushToTalkGesture(hotkey: .rightOption, tapMaxDuration: tapMaxDuration, doubleTapWindow: doubleTapWindow))
        // A double tap: listening hands-free.
        for (down, time) in [(true, 0.0), (false, 0.05), (true, 0.1), (false, 0.15)] {
            _ = monitor.handle(.flagsChanged, keyCode: rightOption, flags: down ? .maskAlternate : [], isRepeat: false, at: time)
        }
        #expect(!monitor.handle(.keyDown, keyCode: space, flags: [], isRepeat: false, at: 0.2), "Space reached the app while listening hands-free")
        _ = monitor.handle(.keyUp, keyCode: space, flags: [], isRepeat: false, at: 0.25)
        // The actions are sent from the main queue, after the event tap returns.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
        #expect(lines.all.compactMap { $0["action"]?.string } == ["start", "finish", "startHandsFree", "listenHandsFree", "toggleMode"])

        await channel.handle(line: Data(#"{"id":1,"method":"dictationEnded"}"#.utf8))

        #expect(lines.all.contains(["id": 1, "result": [:]]))
        #expect(monitor.handle(.keyDown, keyCode: space, flags: [], isRepeat: false, at: 0.3), "Space kept from the app after the dictation ended")
    }

    /// The app says when the chat window opens and closes: while it is open Escape is kept from the app
    /// and reaches it as `closeChat`; a request without `isOpen` fails and changes nothing.
    @Test func setChatOpenGivesEscapeToTheChatWindow() async {
        let lines = Lines()
        let channel = HelperChannel(output: { lines.append($0) })
        let monitor = HotkeyService.register(on: channel)
        monitor.configure(PushToTalkGesture(hotkey: .rightOption, tapMaxDuration: tapMaxDuration, doubleTapWindow: doubleTapWindow))

        await channel.handle(line: Data(#"{"id":1,"method":"setChatOpen","params":{}}"#.utf8))
        #expect(lines.all.contains { $0["id"] == 1 && $0["error"] != nil })
        #expect(monitor.handle(.keyDown, keyCode: escape, flags: [], isRepeat: false, at: 0.1), "Escape kept without the chat window open")

        await channel.handle(line: Data(#"{"id":2,"method":"setChatOpen","params":{"isOpen":true}}"#.utf8))
        #expect(lines.all.contains(["id": 2, "result": [:]]))
        #expect(!monitor.handle(.keyDown, keyCode: escape, flags: [], isRepeat: false, at: 0.2), "Escape reached the app with the chat window open")
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
        #expect(lines.all.compactMap { $0["action"]?.string } == ["closeChat"])

        await channel.handle(line: Data(#"{"id":3,"method":"setChatOpen","params":{"isOpen":false}}"#.utf8))
        #expect(monitor.handle(.keyDown, keyCode: escape, flags: [], isRepeat: false, at: 0.3), "Escape kept after the chat window closed")
    }
}
