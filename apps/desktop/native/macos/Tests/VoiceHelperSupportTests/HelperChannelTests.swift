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

    /// A whole number in range reads as an `Int`; a fraction, one out of range, or no number does not.
    @Test func anIntegerIsAWholeNumberInRange() {
        #expect(JSON.number(7).integer == 7)
        #expect(JSON.number(-3).integer == -3)
        #expect(JSON.number(1.5).integer == nil)
        #expect(JSON.number(1e100).integer == nil)
        #expect(JSON.string("7").integer == nil)
    }

    @Test func closedInputRunsTheEndHandlersInOrderBeforeExiting() async {
        let channel = HelperChannel(output: { _ in })
        let ran = OSAllocatedUnfairLock<[String]>(initialState: [])
        channel.onEnd { ran.withLock { $0.append("first") } }
        channel.onEnd { ran.withLock { $0.append("second") } }
        let input = Pipe()
        await withCheckedContinuation { (exited: CheckedContinuation<Void, Never>) in
            channel.start(input: input.fileHandleForReading, exit: {
                ran.withLock { $0.append("exit") }
                exited.resume()
            })
            try? input.fileHandleForWriting.close()
        }
        #expect(ran.withLock { $0 } == ["first", "second", "exit"])
    }

    /// The helpers live as long as the app, so a request must leave nothing behind once answered:
    /// thousands of requests read through `start` keep the process's footprint flat. (Each read once
    /// stayed in memory for good, about 16 KB a request, and a helper reached hundreds of MB.)
    @Test func readingRequestsKeepsTheFootprintFlat() throws {
        let requests = 3000
        let allowedGrowth = 8 * 1024 * 1024
        let answered = DispatchSemaphore(value: 0)
        let channel = HelperChannel(output: { _ in answered.signal() })
        channel.on("ping") { _ in .null }
        let input = Pipe()
        channel.start(input: input.fileHandleForReading, exit: {})
        defer { try? input.fileHandleForWriting.close() }
        func send(_ count: Int) throws {
            for id in 0..<count {
                try input.fileHandleForWriting.write(contentsOf: Data(#"{"id":\#(id),"method":"ping"}"#.utf8 + [0x0A]))
                answered.wait()
            }
        }
        try send(200) // Warm up: the first requests fill caches that stay, leak or not.
        let before = try #require(Self.footprint())
        try send(requests)
        let after = try #require(Self.footprint())
        #expect(after - before < allowedGrowth, "footprint grew \(after - before) bytes over \(requests) requests")
    }

    /// The process's physical footprint, as `footprint` reports it.
    private static func footprint() -> Int? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let status = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return status == KERN_SUCCESS ? Int(info.phys_footprint) : nil
    }

    @Test func eventsCarryTheirName() {
        let (channel, lines) = channel()
        channel.emit("action", ["action": "start"])
        #expect(lines.all == [["event": "action", "action": "start"]])
    }
}
