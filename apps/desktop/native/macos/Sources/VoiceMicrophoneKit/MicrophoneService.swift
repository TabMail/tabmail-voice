// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import CVoiceCore
import Foundation
import VoiceHelperSupport

/// The requests `voice-microphone` answers: the microphone, and nothing else, in a process of its
/// own, which runs one engine: the process ends itself (`restartExitCode`) at once when a session
/// it ran stops, after the chunks already queued when its engine failed to start or the input
/// device changes, and the app starts it afresh at once, which prepares the next engine
/// (`MicrophoneCapture` says why). A dictation running when the input changes ends as any exit of
/// its helper ends it: what was said is sent. The reply to a stop that ends the process does not
/// get out, and that to a failed start may not; the app takes that exit as their answer.
///
/// - `microphonePrepare` → `{}`: the microphone-off setup, ahead of the first dictation.
/// - `microphoneStart {session, sampleRate}` → `{}` once the microphone runs; then events
///   `{"event": "microphoneChunk", session, samples}`, `samples` being base64 of little-endian
///   32-bit float mono samples at `sampleRate`. `microphoneStop {session}` → `{}`: the microphone
///   off.
public enum MicrophoneService {
    static let microphoneChunkEvent = "microphoneChunk"
    /// The process's exit code when it ends itself to be started afresh: the app's
    /// `microphoneHelperRestartExitCode`.
    static let restartExitCode = Int32(VoiceMicrophoneRestartExitCode)

    /// A chunk event's fields: its session, and its samples as base64 of little-endian 32-bit floats.
    static func microphoneChunk(session: Int, samples: [Float]) -> [String: JSON] {
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        return ["session": .number(Double(session)), "samples": .string(data.base64EncodedString())]
    }

    /// A `microphoneStart` or `microphoneStop` request's session and, for a start, its recording
    /// rate, as the shared core accepts them (`voice_core_request_json`, its cases in
    /// `shared/context/request-cases.json`); nil when the core refuses them.
    static func checked(_ method: String, _ params: [String: JSON?]) -> (session: Int, sampleRate: Double)? {
        let fields = params.mapValues { $0 ?? .null }
        guard voice_core_abi_version() == 1, let input = try? JSONEncoder().encode(JSON.object([method: .object(fields)])) else { return nil }
        var output = VoiceCoreBuffer(data: nil, length: 0)
        let status = input.withUnsafeBytes { bytes in
            voice_core_request_json(bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count, &output)
        }
        defer { voice_core_buffer_free(output) }
        guard status == 0, let data = output.data,
              let reply = try? JSONDecoder().decode(JSON.self, from: Data(bytes: data, count: output.length)),
              let session = reply["session"]?.integer else { return nil }
        return (session, reply["sampleRate"]?.number ?? 0)
    }

    /// Ends the process after the chunks already queued on `chunkQueue`, so the app has all that
    /// was heard.
    static func ending(after chunkQueue: DispatchQueue, end: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        {
            chunkQueue.async {
                HelperLog.debug("MicrophoneService: ending, to be started afresh")
                end()
            }
        }
    }

    public static func register(on channel: HelperChannel) -> AnyObject {
        // Without the process's exit handlers: they would release what the audio system holds, which
        // is what waits when a device has changed.
        register(on: channel, end: { _exit(restartExitCode) })
    }

    /// Ends the process at once, the chunks still queued dropped: the app stopped the session they
    /// belong to. Not behind them, as writing one waits on the app reading the pipe, and the
    /// microphone runs until the process ends.
    static func endingNow(end: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        {
            HelperLog.debug("MicrophoneService: stopped; ending at once, to be started afresh")
            end()
        }
    }

    /// `end` ends the process, or is a test's stand-in.
    static func register(on channel: HelperChannel, end: @escaping @Sendable () -> Void) -> AnyObject {
        // Off the render thread: encoding and writing a chunk must never hold up the audio.
        let chunkQueue = DispatchQueue(label: "ai.tabmail.voice.helper.microphoneChunks", qos: .userInitiated)
        let microphone = MicrophoneCapture(
            onSamples: { session, samples in
                chunkQueue.async {
                    channel.emit(microphoneChunkEvent, microphoneChunk(session: session, samples: samples))
                }
            },
            onEnd: ending(after: chunkQueue, end: end),
            onStopped: endingNow(end: end)
        )

        channel.on("microphonePrepare") { _ in
            await microphone.prepare()
            return [:]
        }
        channel.on("microphoneStart") { params in
            guard let (session, sampleRate) = checked("microphoneStart", ["session": params["session"], "sampleRate": params["sampleRate"]]) else {
                throw HelperError("microphoneStart needs a session and sampleRate the shared core accepts")
            }
            do {
                try await microphone.start(session: session, sampleRate: sampleRate)
            } catch {
                throw HelperError("microphone: \(type(of: error))")
            }
            return [:]
        }
        channel.on("microphoneStop") { params in
            guard let (session, _) = checked("microphoneStop", ["session": params["session"]]) else {
                throw HelperError("microphoneStop needs a session the shared core accepts")
            }
            await microphone.stop(session: session)
            return [:]
        }
        return microphone
    }
}
