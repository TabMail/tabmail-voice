// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// The requests `voice-microphone` answers: the microphone, and nothing else, in a process of its
/// own, which runs one engine: the process ends itself (`restartExitCode`) once its engine has run
/// or failed to start, or the input device changes, and the app starts it afresh at once, which
/// prepares the next engine (`MicrophoneCapture` says why). A dictation running when the input
/// changes ends as any exit of its helper ends it: what was said is sent. The reply to the stop or
/// the failed start that ends the process may not get out first; the app takes that exit as their
/// answer.
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
    static let restartExitCode: Int32 = 75

    /// A chunk event's fields: its session, and its samples as base64 of little-endian 32-bit floats.
    static func microphoneChunk(session: Int, samples: [Float]) -> [String: JSON] {
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        return ["session": .number(Double(session)), "samples": .string(data.base64EncodedString())]
    }

    public static func register(on channel: HelperChannel) -> AnyObject {
        // Without the process's exit handlers: they would release what the audio system holds, which
        // is what waits when a device has changed.
        register(on: channel, end: { _exit(restartExitCode) })
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
            // After the chunks already queued, so the app has all that was heard.
            onEnd: {
                chunkQueue.async {
                    HelperLog.debug("MicrophoneService: ending, to be started afresh")
                    end()
                }
            }
        )

        channel.on("microphonePrepare") { _ in
            await microphone.prepare()
            return [:]
        }
        channel.on("microphoneStart") { params in
            guard let session = params["session"]?.integer, let sampleRate = params["sampleRate"]?.number, sampleRate > 0 else {
                throw HelperError("microphoneStart needs session and sampleRate")
            }
            do {
                try await microphone.start(session: session, sampleRate: sampleRate)
            } catch {
                throw HelperError("microphone: \(type(of: error))")
            }
            return [:]
        }
        channel.on("microphoneStop") { params in
            guard let session = params["session"]?.integer else { throw HelperError("microphoneStop needs session") }
            await microphone.stop(session: session)
            return [:]
        }
        return microphone
    }
}
