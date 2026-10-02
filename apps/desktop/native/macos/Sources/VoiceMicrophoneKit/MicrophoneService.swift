// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// The requests `voice-microphone` answers: the microphone, and nothing else, in a process of its
/// own. The process ends itself when the input device changes (`inputChangedExitCode`) and the app
/// starts it afresh at once: an engine that outlives a change of its device held up every start
/// for up to minutes, and only a new process is sure to have none. A dictation running at that
/// moment ends as any exit of its helper ends it: what was said is sent.
///
/// - `microphonePrepare` → `{}`: the microphone-off setup, ahead of the first dictation.
/// - `microphoneStart {session, sampleRate}` → `{}` once the microphone runs; then events
///   `{"event": "microphoneChunk", session, samples}`, `samples` being base64 of little-endian
///   32-bit float mono samples at `sampleRate`. `microphoneStop {session}` → `{}`: the microphone
///   off.
public enum MicrophoneService {
    static let microphoneChunkEvent = "microphoneChunk"
    /// The process's exit code when it ends itself for a changed input device: the app's
    /// `microphoneHelperRestartExitCode`.
    static let inputChangedExitCode: Int32 = 75

    /// A chunk event's fields: its session, and its samples as base64 of little-endian 32-bit floats.
    static func microphoneChunk(session: Int, samples: [Float]) -> [String: JSON] {
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        return ["session": .number(Double(session)), "samples": .string(data.base64EncodedString())]
    }

    public static func register(on channel: HelperChannel) -> AnyObject {
        // Without the process's exit handlers: they would release what the audio system holds, which
        // is what waits when a device has changed.
        register(on: channel, end: { _exit(inputChangedExitCode) })
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
            onInputChanged: {
                chunkQueue.async {
                    HelperLog.debug("MicrophoneService: the input device changed; ending, to be started afresh")
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
