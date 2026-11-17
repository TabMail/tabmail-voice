// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import Foundation
import os
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
        #expect(cases.count == 10)
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

/// A stop at any point after a start leaves the helper alive until it ends itself to be started
/// afresh: the engine that started is never stopped in the process, as `AVAudioEngine.stop` just
/// after `start` tears the input down under Core Audio's IO thread, which then crashes the process.
/// No microphone is used: each engine is a stand-in whose `start` and `stop` touch no device.
struct MicrophoneCaptureStopTests {
    struct StartFailed: Error {}

    /// An engine that runs no audio, and records each stop: one here is the crash.
    final class StandInEngine: AVAudioEngine, @unchecked Sendable {
        let stops: OSAllocatedUnfairLock<Int>
        let fails: Bool
        init(stops: OSAllocatedUnfairLock<Int>, fails: Bool) {
            self.stops = stops
            self.fails = fails
            super.init()
        }
        override func start() throws { if fails { throw StartFailed() } }
        override func stop() { stops.withLock { $0 += 1 } }
    }

    final class Recorder: @unchecked Sendable {
        let stops = OSAllocatedUnfairLock(initialState: 0)
        let chunks = OSAllocatedUnfairLock<[Int]>(initialState: [])
        /// Ends after the queued chunks (the input changed, a start failed), and at once (a stop).
        let ends = OSAllocatedUnfairLock(initialState: 0)
        let stoppedEnds = OSAllocatedUnfairLock(initialState: 0)
        let startFails: Bool
        let factoryFails: Bool
        /// The engine built, held weakly: only the capture keeps it.
        weak var engine: StandInEngine?
        /// The tap's handler; set as the engine is built, before the start that reads it.
        var deliver: (@Sendable (AVAudioPCMBuffer) -> Void)?

        init(startFails: Bool = false, factoryFails: Bool = false) {
            self.startFails = startFails
            self.factoryFails = factoryFails
        }

        func capture() -> MicrophoneCapture {
            MicrophoneCapture(
                onSamples: { session, _ in self.chunks.withLock { $0.append(session) } },
                onEnd: { self.ends.withLock { $0 += 1 } },
                onStopped: { self.stoppedEnds.withLock { $0 += 1 } },
                makeEngine: { deliver in
                    if self.factoryFails { throw StartFailed() }
                    let engine = StandInEngine(stops: self.stops, fails: self.startFails)
                    self.engine = engine
                    self.deliver = deliver
                    return engine
                }
            )
        }

        func hear() throws {
            let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false))
            let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096))
            buffer.frameLength = 4096
            let deliver = try #require(self.deliver)
            deliver(buffer)
        }

        var counts: (stops: Int, ends: Int, stoppedEnds: Int) {
            (stops.withLock { $0 }, ends.withLock { $0 }, stoppedEnds.withLock { $0 })
        }
    }

    @Test(arguments: [false, true])
    func aStopRightAfterTheStartEndsTheProcessWithoutStoppingTheEngine(prepared: Bool) async throws {
        let recorder = Recorder()
        let capture = recorder.capture()
        if prepared { await capture.prepare() }

        try await capture.start(session: 1, sampleRate: 16_000)
        try recorder.hear()
        await capture.stop(session: 1)
        try recorder.hear()

        #expect(recorder.counts == (0, 0, 1))
        // Heard while it ran, and nothing after the stop.
        #expect(recorder.chunks.withLock { $0 } == [1])
        // Kept running until the process ends, never released here.
        #expect(recorder.engine != nil)
        withExtendedLifetime(capture) {}
    }

    /// A stop for a newer session than the running one stops it too; one for an older session, or
    /// one that arrives before its session's start, leaves nothing running and the process alone
    /// until a start would run.
    @Test func aStopOfANewerSessionEndsTheRunningOne() async throws {
        let recorder = Recorder()
        let capture = recorder.capture()

        try await capture.start(session: 2, sampleRate: 16_000)
        await capture.stop(session: 1)
        #expect(recorder.counts == (0, 0, 0))
        await capture.stop(session: 3)
        try recorder.hear()

        #expect(recorder.counts == (0, 0, 1))
        #expect(recorder.chunks.withLock { $0 }.isEmpty)
        #expect(recorder.engine != nil)
        withExtendedLifetime(capture) {}
    }

    @Test func aStopBeforeItsStartKeepsTheEngineOff() async throws {
        let recorder = Recorder()
        let capture = recorder.capture()

        await capture.stop(session: 1)
        try await capture.start(session: 1, sampleRate: 16_000)

        #expect(recorder.counts == (0, 0, 0))
        #expect(recorder.engine == nil)
        withExtendedLifetime(capture) {}
    }

    /// A start that comes after this process's engine started ends the process the same way.
    @Test func aStartAfterTheStopEndsTheProcessWithoutStoppingTheEngine() async throws {
        let recorder = Recorder()
        let capture = recorder.capture()

        try await capture.start(session: 1, sampleRate: 16_000)
        await capture.stop(session: 1)
        var refused = false
        do { try await capture.start(session: 2, sampleRate: 16_000) } catch { refused = true }

        #expect(refused)
        #expect(recorder.counts == (0, 0, 2))
        #expect(recorder.engine != nil)
        withExtendedLifetime(capture) {}
    }

    /// A newer session's start supersedes the running one in the same process: it too ends the
    /// process and leaves the engine to its exit.
    @Test func aNewerStartWhileRunningEndsTheProcessWithoutStoppingTheEngine() async throws {
        let recorder = Recorder()
        let capture = recorder.capture()

        try await capture.start(session: 1, sampleRate: 16_000)
        var refused = false
        do { try await capture.start(session: 2, sampleRate: 16_000) } catch { refused = true }
        try recorder.hear()

        #expect(refused)
        #expect(recorder.counts == (0, 0, 1))
        #expect(recorder.chunks.withLock { $0 }.isEmpty)
        #expect(recorder.engine != nil)
        withExtendedLifetime(capture) {}
    }

    /// A start that fails ends the process (after its chunks, of which there are none), and the
    /// engine that failed is kept, not stopped; a stop then has nothing to stop.
    @Test(arguments: [false, true])
    func aFailedStartEndsTheProcessWithoutStoppingTheEngine(inFactory: Bool) async throws {
        let recorder = Recorder(startFails: !inFactory, factoryFails: inFactory)
        let capture = recorder.capture()

        var failed = false
        do { try await capture.start(session: 1, sampleRate: 16_000) } catch { failed = true }
        await capture.stop(session: 1)

        #expect(failed)
        #expect(recorder.counts == (0, 1, 0))
        #expect((recorder.engine != nil) == !inFactory)
        withExtendedLifetime(capture) {}
    }
}
