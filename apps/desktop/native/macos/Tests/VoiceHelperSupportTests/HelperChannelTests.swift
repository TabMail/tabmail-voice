// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
import Testing
@testable import VoiceHelperSupport

/// The helpers' wire format: one request in, one reply out, events in between.
struct HelperChannelTests {
    final class Lines: Sendable {
        private let lines = OSAllocatedUnfairLock<[JSON]>(initialState: [])
        var all: [JSON] { lines.withLock { $0 } }
        func append(_ data: Data) {
            let value = try! JSONDecoder().decode(JSON.self, from: data)
            lines.withLock { $0.append(value) }
        }
    }

    private func channel() -> (HelperChannel, Lines) {
        let lines = Lines()
        return (HelperChannel(output: { lines.append($0) }), lines)
    }

    @Test func aRequestIsAnsweredUnderItsID() async {
        let (channel, lines) = channel()
        channel.on("echo") { params in ["said": params["text"] ?? .null] }

        await channel.handle(line: Data(#"{"id":7,"method":"echo","params":{"text":"hi"}}"#.utf8))

        #expect(lines.all == [["id": 7, "result": ["said": "hi"]]])
    }

    @Test func aFailedRequestCarriesItsMessage() async {
        let (channel, lines) = channel()
        channel.on("fail") { _ in throw HelperError("no such window") }

        await channel.handle(line: Data(#"{"id":1,"method":"fail"}"#.utf8))
        await channel.handle(line: Data(#"{"id":2,"method":"missing"}"#.utf8))

        #expect(lines.all == [
            ["id": 1, "error": ["message": "no such window"]],
            ["id": 2, "error": ["message": "unknown method missing"]],
        ])
    }

    /// A line that is no request gets no reply: there is no id to answer under.
    @Test func anUnreadableLineIsDropped() async {
        let (channel, lines) = channel()
        await channel.handle(line: Data("not json".utf8))
        await channel.handle(line: Data(#"{"method":"echo"}"#.utf8))
        #expect(lines.all.isEmpty)
    }

    @Test func eventsCarryTheirName() {
        let (channel, lines) = channel()
        channel.emit("action", ["action": "start"])
        #expect(lines.all == [["event": "action", "action": "start"]])
    }
}
