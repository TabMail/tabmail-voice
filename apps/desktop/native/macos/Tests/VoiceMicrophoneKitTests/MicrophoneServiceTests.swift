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

    /// The code the process ends itself with for a changed input device is the one the app starts it
    /// afresh for without calling it a failure (`microphoneHelperRestartExitCode` in the app's
    /// config, which `helperContract.test.ts` holds to this).
    @Test func theExitCodeForAChangedInputIsTheAppsRestartCode() {
        #expect(MicrophoneService.inputChangedExitCode == 75)
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
