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
    /// thousands of requests read by a real helper (`voice-field-reader`, which reads them through
    /// `HelperChannel`) keep that process's footprint flat. The child is measured, not this process,
    /// so suites running beside this one cannot move the number. (Each read once stayed in memory for
    /// good, about 16 KB a request, and a helper reached hundreds of MB.)
    @Test func aHelperReadingRequestsKeepsItsFootprintFlat() throws {
        let requests = 3000
        let allowedGrowth: UInt64 = 8 * 1024 * 1024
        // The helpers are built beside this test bundle.
        let products = Bundle(for: Lines.self).bundleURL.deletingLastPathComponent()
        let helper = Process()
        helper.executableURL = products.appendingPathComponent("voice-field-reader")
        let input = Pipe(), output = Pipe()
        helper.standardInput = input
        helper.standardOutput = output
        helper.standardError = FileHandle.nullDevice
        try helper.run()
        defer {
            try? input.fileHandleForWriting.close()
            helper.terminate()
            helper.waitUntilExit()
        }
        var pending = Data()
        // Sends `count` requests one at a time, each answered before the next, so each is its own read.
        func send(_ count: Int) throws {
            for id in 0..<count {
                try input.fileHandleForWriting.write(contentsOf: Data(#"{"id":\#(id),"method":"none"}"#.utf8 + [0x0A]))
                while !pending.contains(0x0A) {
                    let chunk = output.fileHandleForReading.availableData
                    guard !chunk.isEmpty else { throw HelperError("the helper closed its output") }
                    pending.append(chunk)
                }
                pending.removeSubrange(...pending.firstIndex(of: 0x0A)!)
            }
        }
        try send(200) // Warm up: the first requests fill caches that stay, leak or not.
        let before = try #require(Self.footprint(helper.processIdentifier))
        try send(requests)
        let after = try #require(Self.footprint(helper.processIdentifier))
        #expect(after < before + allowedGrowth, "the helper's footprint grew from \(before) to \(after) bytes over \(requests) requests")
    }

    /// A process's physical footprint, as `footprint` reports it.
    private static func footprint(_ pid: pid_t) -> UInt64? {
        var usage = rusage_info_v4()
        let status = withUnsafeMutablePointer(to: &usage) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        return status == 0 ? usage.ri_phys_footprint : nil
    }

    @Test func eventsCarryTheirName() {
        let (channel, lines) = channel()
        channel.emit("action", ["action": "start"])
        #expect(lines.all == [["event": "action", "action": "start"]])
    }
}
