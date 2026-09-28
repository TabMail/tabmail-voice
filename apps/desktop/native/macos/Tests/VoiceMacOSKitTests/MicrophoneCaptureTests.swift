// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// A captured buffer as the app receives it: mono float samples at the rate it asked for, every
/// channel mixed in. No microphone is used.
struct MicrophoneCaptureTests {
    private let deviceRate: Double = 48_000
    private let appRate: Double = 16_000

    /// A 440 Hz tone at `amplitude` on each of `channels`, `frames` long, at the device's rate.
    private func tone(channels: AVAudioChannelCount, amplitudes: [Float], frames: AVAudioFrameCount = 4096) throws -> AVAudioPCMBuffer {
        let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: deviceRate, channels: channels, interleaved: false))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let data = try #require(buffer.floatChannelData)
        for channel in 0..<Int(channels) {
            for frame in 0..<Int(frames) {
                data[channel][frame] = amplitudes[channel] * sin(2 * .pi * 440 * Float(frame) / Float(deviceRate))
            }
        }
        return buffer
    }

    private func peak(_ samples: ArraySlice<Float>) -> Float {
        samples.map(abs).max() ?? 0
    }

    @Test func aBufferBecomesMonoAtTheAppsRate() throws {
        let (converter, samples) = try MicrophoneCapture.convert(try tone(channels: 1, amplitudes: [0.5]), sampleRate: appRate, converter: nil)

        #expect(converter.outputFormat.sampleRate == appRate && converter.outputFormat.channelCount == 1)
        // A third as many frames, less the converter's start-up latency; the tone kept its loudness.
        #expect(samples.count > 4096 / 3 - 64 && samples.count <= 4096 / 3 + 1, "\(samples.count) samples")
        #expect(abs(peak(samples.suffix(512)) - 0.5) < 0.05)
    }

    /// A stereo interface's second channel is heard too: mixed down, not dropped.
    @Test func everyChannelIsMixedIn() throws {
        let (_, samples) = try MicrophoneCapture.convert(try tone(channels: 2, amplitudes: [0, 0.5]), sampleRate: appRate, converter: nil)

        #expect(peak(samples.suffix(512)) > 0.1)
    }

    /// The next buffer of the same format reuses the converter, which carries the stream on; a buffer
    /// of another format (the device changed) gets a new one.
    @Test func theConverterIsKeptForTheSameFormatOnly() throws {
        let (first, _) = try MicrophoneCapture.convert(try tone(channels: 1, amplitudes: [0.5]), sampleRate: appRate, converter: nil)
        let (same, _) = try MicrophoneCapture.convert(try tone(channels: 1, amplitudes: [0.5]), sampleRate: appRate, converter: first)
        let (other, _) = try MicrophoneCapture.convert(try tone(channels: 2, amplitudes: [0.5, 0.5]), sampleRate: appRate, converter: first)

        #expect(same === first)
        #expect(other !== first)
    }

    /// On the render thread, a buffer is converted for the running session, whose converter is kept
    /// for its next buffer; with no session running, nothing is.
    @Test func eachBufferGoesToTheRunningSessionOnItsKeptConverter() throws {
        var state: MicrophoneCapture.TapState? = nil
        #expect(MicrophoneCapture.convert(try tone(channels: 1, amplitudes: [0.5]), for: &state) == nil)

        state = MicrophoneCapture.TapState(session: 3, sampleRate: appRate)
        let first = try #require(MicrophoneCapture.convert(try tone(channels: 1, amplitudes: [0.5]), for: &state))
        let converter = try #require(state?.converter)
        let second = try #require(MicrophoneCapture.convert(try tone(channels: 1, amplitudes: [0.5]), for: &state))

        #expect(first.0 == 3 && second.0 == 3)
        #expect(state?.converter === converter)
        // Carried on, the second buffer has no start-up latency: all its frames at the app's rate.
        #expect(second.1.count > first.1.count)
    }
}

/// Which session the microphone runs for, as the app's starts and stops reach the helper in any
/// order (each request is handled in its own task). The app always stops a session before starting
/// the next.
struct MicrophoneSessionsTests {
    /// What each start or stop decided, in order, and the session left running.
    private func run(_ steps: [(start: Bool, session: Int)]) -> (decisions: [Bool], running: Int?) {
        var sessions = MicrophoneSessions()
        let decisions = steps.map { $0.start ? sessions.start($0.session) : sessions.stop($0.session) }
        return (decisions, sessions.running)
    }

    @Test func aStartRunsUntilItsStop() {
        #expect(run([(true, 1)]) == ([true], 1))
        #expect(run([(true, 1), (false, 1)]) == ([true, true], nil))
    }

    /// Stop(n) handled before its start: the microphone never starts for n.
    @Test func aStopBeforeItsStartKeepsTheMicrophoneOff() {
        #expect(run([(false, 1), (true, 1)]) == ([false, false], nil))
    }

    /// Start(n+1) handled before stop(n): n+1 runs, and the late stop(n) leaves it running.
    @Test func aLateStopLeavesTheNewerSessionRunning() {
        #expect(run([(true, 1), (true, 2), (false, 1)]) == ([true, true, false], 2))
    }

    /// Start(n+1), then a late start(n), then stop(n): the newer session keeps the microphone until
    /// its own stop.
    @Test func aLateStartDoesNotTakeOverFromANewerSession() {
        #expect(run([(true, 2), (true, 1), (false, 1)]) == ([true, false, false], 2))
        #expect(run([(true, 2), (true, 1), (false, 1), (false, 2)]) == ([true, false, false, true], nil))
    }

    /// Stops repeated, or of a session long gone, change nothing; a start after its own stop does not run.
    @Test func repeatedStopsChangeNothing() {
        #expect(run([(true, 1), (false, 1), (false, 1), (true, 1), (true, 2)]) == ([true, true, false, false, true], 2))
    }

    /// A failed start runs nothing, and the next session starts.
    @Test func aFailedStartRunsNothing() {
        var sessions = MicrophoneSessions()
        let started = sessions.start(2)
        sessions.failed(2)
        #expect(started && sessions.running == nil)
        let stopped = sessions.stop(2)
        let next = sessions.start(3)
        #expect(!stopped && next && sessions.running == 3)
    }

    /// Start(2) failed while the app's stop(1) is still on its way: a late start(1) does not run.
    @Test func aFailedStartKeepsOlderSessionsOff() {
        var sessions = MicrophoneSessions()
        let started = sessions.start(2)
        sessions.failed(2)
        let late = sessions.start(1)
        #expect(started && !late && sessions.running == nil)
    }
}

/// A request whose number is no whole number in range (a fraction, 1e100) is refused with an
/// error, not converted: a trapping conversion would crash the helper, and with it the dictation.
@MainActor
struct MacServiceRequestTests {
    @Test func aMalformedNumberIsRefusedNotTrappedOn() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(on: channel)
        let requests = [
            #"{"id":1,"method":"microphoneStop","params":{"session":1e100}}"#,
            #"{"id":2,"method":"microphoneStart","params":{"session":1.5,"sampleRate":16000}}"#,
            #"{"id":3,"method":"caretAnchor","params":{"pid":1e100}}"#,
            #"{"id":4,"method":"globeUpdate","params":{"value":1e100}}"#,
            #"{"id":5,"method":"insert","params":{"text":"x","restoreDelay":1e300}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
        withExtendedLifetime(service) {}
    }
}

/// A chunk as the app reads it off the wire: its session a number, its samples base64 of
/// little-endian 32-bit floats that decode back to the samples sent.
@MainActor
struct MicrophoneChunkEventTests {
    @Test func aChunkEventCarriesANumericSessionAndItsSamples() throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let samples: [Float] = [0.25, -0.5, 1]

        channel.emit(MacService.microphoneChunkEvent, MacService.microphoneChunk(session: 7, samples: samples))

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
