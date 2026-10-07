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

/// Which session the microphone runs for, and when the process ends: the shared cases every
/// `voice-microphone` runs through the core (`native/shared/microphone/session-cases.json`).
struct MicrophoneSessionsTests {
    struct Case: Decodable {
        struct Step: Decodable {
            let event: String
            let session: Int
            let decision: String?
            let stopped: Bool?
            let running: Int?
            let mayPrepare: Bool
        }
        let name: String
        let steps: [Step]
    }

    @Test func sharedSessionCases() throws {
        let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: native.appendingPathComponent("shared/microphone/session-cases.json")))
        #expect(cases.count == 9)
        for test in cases {
            var sessions = MicrophoneSessions()
            for step in test.steps {
                switch step.event {
                case "start":
                    let expected: MicrophoneSessions.Start? = switch step.decision {
                    case "runs": .runs
                    case "skipped": .skipped
                    case "endsProcess": .endsProcess
                    default: nil
                    }
                    #expect(sessions.start(step.session) == expected, "\(test.name)")
                case "stop": #expect(sessions.stop(step.session) == step.stopped, "\(test.name)")
                case "failed": sessions.failed(step.session)
                default: Issue.record("Unknown session event"); return
                }
                #expect(sessions.running == step.running && sessions.mayPrepare == step.mayPrepare, "\(test.name)")
            }
        }
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
