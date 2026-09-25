// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation

/// Streams microphone buffers while dictation is active.
///
/// The engine is created per session and fully torn down in `stop()`, so the microphone is
/// released (and the menu-bar mic indicator clears) as soon as the user lets go of the key.
/// iOS lesson (tabmail-ios memory 086): a leaked, still-active audio session has process-wide
/// side effects — never leave the input running between dictations.
final class MicrophoneCapture: @unchecked Sendable {
    enum CaptureError: Error {
        case noInputDevice
    }

    // Accessed only from the owning session's start/stop, never concurrently.
    private var engine: AVAudioEngine?

    /// Starts the microphone. `onBuffer` runs on the audio render thread.
    func start(onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws -> AVAudioFormat {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError.noInputDevice
        }
        input.installTap(onBus: 0, bufferSize: DictationConfig.audioTapBufferSize, format: format) { buffer, _ in
            onBuffer(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        self.engine = engine
        return format
    }

    func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }

    /// Normalised 0…1 loudness of a buffer, for the overlay meter.
    static func level(of buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let count = Int(buffer.frameLength)
        var sumOfSquares: Float = 0
        for index in 0..<count {
            sumOfSquares += samples[index] * samples[index]
        }
        let rms = (sumOfSquares / Float(count)).squareRoot()
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        let floor = DictationConfig.levelDecibelFloor
        return max(0, min(1, (decibels - floor) / -floor))
    }
}
