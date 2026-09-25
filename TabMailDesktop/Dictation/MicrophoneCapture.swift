// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import CoreAudio
import os

/// Streams buffers from the system default microphone while dictation is active.
///
/// Starting a microphone is slow (≈ 0.5 s to open the input node, ≈ 0.5 s to start the device),
/// so the slow half that does NOT switch the microphone on — creating the engine, opening the
/// input node, installing the tap, `prepare()` — is done ahead of time (`prepare()`, and again
/// after every dictation). `start` then only starts the device. All engine work runs on one
/// serial queue, never the main thread, so the UI stays responsive while the device boots.
///
/// The microphone itself is running only between `start` and `stop`: the engine is stopped and
/// discarded after every dictation (iOS lesson: a leaked, still-active audio session has
/// process-wide side effects), and a prepared engine never opens the device.
final class MicrophoneCapture: @unchecked Sendable {
    enum CaptureError: Error {
        case noInputDevice
    }

    private struct Prepared {
        let engine: AVAudioEngine
        let device: AudioDeviceID
    }

    private let queue = DispatchQueue(label: "ai.tabmail.desktop.microphone", qos: .userInitiated)
    private let handler = OSAllocatedUnfairLock<(@Sendable (AVAudioPCMBuffer) -> Void)?>(initialState: nil)
    // Queue-confined.
    private var prepared: Prepared?
    private var running: AVAudioEngine?
    private var defaultDeviceListener: AudioObjectPropertyListenerBlock?

    init() {
        // The user switched the default input (System Settings › Sound, AirPods connecting…):
        // a prepared engine is bound to the old device, so rebuild it.
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            self.prepared = nil
            self.prepareOnQueue()
        }
        var address = Self.defaultInputAddress
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue, listener)
        defaultDeviceListener = listener
    }

    deinit {
        if let defaultDeviceListener {
            var address = Self.defaultInputAddress
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue, defaultDeviceListener)
        }
    }

    /// Does the slow, microphone-off setup ahead of the next `start`.
    func prepare() {
        queue.async { self.prepareOnQueue() }
    }

    /// Starts the microphone. `onBuffer` runs on the audio render thread; `completion` on the
    /// capture queue, with the error if the device couldn't start.
    func start(
        onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void,
        completion: @escaping @Sendable ((any Error)?) -> Void
    ) {
        handler.withLock { $0 = onBuffer }
        queue.async {
            do {
                let current = Self.defaultInputDevice()
                let engine: AVAudioEngine
                if let prepared = self.prepared, prepared.device == current {
                    engine = prepared.engine
                } else {
                    engine = try self.makeEngine()
                }
                self.prepared = nil
                try engine.start()
                self.running = engine
                completion(nil)
            } catch {
                self.handler.withLock { $0 = nil }
                completion(error)
            }
        }
    }

    /// Stops the microphone (if running) and prepares a fresh engine for next time.
    func stop() {
        handler.withLock { $0 = nil }
        queue.async {
            if let engine = self.running {
                engine.inputNode.removeTap(onBus: 0)
                engine.stop()
                self.running = nil
            }
            self.prepareOnQueue()
        }
    }

    private func prepareOnQueue() {
        guard prepared == nil, running == nil else { return }
        do {
            let device = Self.defaultInputDevice()
            prepared = Prepared(engine: try makeEngine(), device: device)
        } catch {
            Log.error("MicrophoneCapture: prepare failed: \(type(of: error))")
        }
    }

    private func makeEngine() throws -> AVAudioEngine {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError.noInputDevice
        }
        input.installTap(onBus: 0, bufferSize: DictationConfig.audioTapBufferSize, format: format) { [handler] buffer, _ in
            handler.withLock { $0 }?(buffer)
        }
        engine.prepare()
        return engine
    }

    private static var defaultInputAddress: AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
    }

    /// The system default input device (System Settings › Sound › Input).
    private static func defaultInputDevice() -> AudioDeviceID {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = defaultInputAddress
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        return device
    }

    /// RMS loudness of a buffer in dBFS (`meterSilenceDecibels` for digital silence).
    static func decibels(of buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return DictationConfig.meterSilenceDecibels }
        let count = Int(buffer.frameLength)
        var sumOfSquares: Float = 0
        for index in 0..<count {
            sumOfSquares += samples[index] * samples[index]
        }
        let rms = (sumOfSquares / Float(count)).squareRoot()
        guard rms > 0 else { return DictationConfig.meterSilenceDecibels }
        return max(20 * log10(rms), DictationConfig.meterSilenceDecibels)
    }

    /// Loudness on a fixed 0…1 scale (`levelDecibelFloor` … 0 dBFS), for diagnostics.
    static func level(of buffer: AVAudioPCMBuffer) -> Float {
        let floor = DictationConfig.levelDecibelFloor
        return max(0, min(1, (decibels(of: buffer) - floor) / -floor))
    }
}
