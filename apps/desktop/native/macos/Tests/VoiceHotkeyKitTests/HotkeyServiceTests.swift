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

    /// A dictation that ended without the hotkey (the length cap, a failure, the menu) ends hands-free
    /// listening: once the app says so, Space reaches the app in front again.
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

        await channel.handle(line: Data(#"{"id":1,"method":"dictationEnded"}"#.utf8))

        #expect(lines.all.contains(["id": 1, "result": [:]]))
        #expect(monitor.handle(.keyDown, keyCode: space, flags: [], isRepeat: false, at: 0.3), "Space kept from the app after the dictation ended")
    }
}
