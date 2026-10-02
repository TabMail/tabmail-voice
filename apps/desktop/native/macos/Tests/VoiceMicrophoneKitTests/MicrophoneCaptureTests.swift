// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import Foundation
import Testing
@testable import VoiceMicrophoneKit

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

/// How the input device is connected, as the log names it: the transport's four characters, which
/// name no device.
struct MicrophoneTransportNameTests {
    @Test func aTransportIsNamedByItsFourCharacters() {
        #expect(MicrophoneCapture.transportName(0x626C_7565) == "blue")
        #expect(MicrophoneCapture.transportName(0x626C_746E) == "bltn")
        // "usb " is padded with a space.
        #expect(MicrophoneCapture.transportName(0x7573_6220) == "usb")
    }

    @Test func aTransportThatDoesNotSayIsUnknown() {
        #expect(MicrophoneCapture.transportName(0) == "unknown")
        #expect(MicrophoneCapture.transportName(0xFFFF_FFFF) == "unknown")
        #expect(MicrophoneCapture.transportName(0x7F7F_7F7F) == "unknown")
    }
}
