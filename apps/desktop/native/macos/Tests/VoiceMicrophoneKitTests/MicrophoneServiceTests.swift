// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMicrophoneKit

/// A request whose number is no whole number in range (a fraction, 1e100) is refused with an
/// error, not converted: a trapping conversion would crash the helper, and with it the dictation.
struct MicrophoneServiceRequestTests {
    @Test func aMalformedNumberIsRefusedNotTrappedOn() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MicrophoneService.register(on: channel, end: {})
        let requests = [
            #"{"id":1,"method":"microphoneStop","params":{"session":1e100}}"#,
            #"{"id":2,"method":"microphoneStart","params":{"session":1.5,"sampleRate":16000}}"#,
            #"{"id":3,"method":"microphoneStart","params":{"session":1,"sampleRate":0}}"#,
            #"{"id":4,"method":"microphoneStart","params":{"session":1}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
        withExtendedLifetime(service) {}
    }

    /// A stop for a session that is not running (the app's stop reaching the helper started afresh
    /// after an input change) is answered, and the process goes on with its prepared engine.
    @Test func aStopWithNothingRunningKeepsTheProcess() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let ended = OSAllocatedUnfairLock(initialState: false)
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MicrophoneService.register(on: channel, end: { ended.withLock { $0 = true } })

        await channel.handle(line: Data(#"{"id":1,"method":"microphoneStop","params":{"session":1}}"#.utf8))
        // Anything ending the process would be on the chunk queue by now; let it run.
        try await Task.sleep(for: .milliseconds(100))

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == 1 && replies.first?["result"] != nil)
        #expect(!ended.withLock { $0 })
        withExtendedLifetime(service) {}
    }

    /// The code the process ends itself with to be started afresh is the one the app restarts it at
    /// once for without calling it a failure (`microphoneHelperRestartExitCode` in the app's config,
    /// which `helperContract.test.ts` holds to this).
    @Test func theRestartExitCodeIsTheAppsRestartCode() {
        #expect(MicrophoneService.restartExitCode == 75)
    }
}

/// The process ends only after the chunks already queued are sent, so the app has all that was
/// heard, and it does end.
struct MicrophoneServiceEndingTests {
    @Test func theProcessEndsAfterTheQueuedChunks() async {
        let order = OSAllocatedUnfairLock<[String]>(initialState: [])
        let chunkQueue = DispatchQueue(label: "ai.tabmail.voice.helper.test.microphoneChunks")
        let gate = DispatchSemaphore(value: 0)
        chunkQueue.async {
            gate.wait()
            order.withLock { $0.append("chunk") }
        }
        let ended = DispatchSemaphore(value: 0)
        MicrophoneService.ending(after: chunkQueue, end: {
            order.withLock { $0.append("end") }
            ended.signal()
        })()
        gate.signal()
        let result = await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: ended.wait(timeout: .now() + .seconds(5)))
            }
        }
        #expect(result == .success)
        #expect(order.withLock { $0 } == ["chunk", "end"])
    }
}

/// A chunk as the app reads it off the wire: its session a number, its samples base64 of
/// little-endian 32-bit floats that decode back to the samples sent.
struct MicrophoneChunkEventTests {
    @Test func aChunkEventCarriesANumericSessionAndItsSamples() throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let samples: [Float] = [0.25, -0.5, 1]

        channel.emit(MicrophoneService.microphoneChunkEvent, MicrophoneService.microphoneChunk(session: 7, samples: samples))

        let line = try #require(lines.withLock { $0.first })
        let object = try #require(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        #expect(object["event"] as? String == "microphoneChunk")
        #expect((object["session"] as? NSNumber)?.intValue == 7 && !(object["session"] is String))
        let encoded = try #require(object["samples"] as? String)
        let bytes = try #require(Data(base64Encoded: encoded))
        #expect(bytes.count == samples.count * 4)
        let decoded = (0..<samples.count).map { index in
            Float(bitPattern: UInt32(bytes[index * 4]) | UInt32(bytes[index * 4 + 1]) << 8 | UInt32(bytes[index * 4 + 2]) << 16 | UInt32(bytes[index * 4 + 3]) << 24)
        }
        #expect(decoded == samples)
    }
}
