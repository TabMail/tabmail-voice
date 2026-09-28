// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import CoreAudio
import os
import VoiceHelperSupport

/// The system default microphone, as the Swift app's `MicrophoneCapture` runs it: an `AVAudioEngine`
/// whose slow, microphone-off setup (the engine, the input node, the tap, `prepare()`) is done ahead
/// of time, so `start` only starts the device (≈ 0.6 s from key-down to the first audio, against
/// ≈ 1.5 s for Chromium's `getUserMedia`, which opens the device afresh each time). Each buffer is
/// converted to mono float samples at the app's rate and handed to `onSamples`.
///
/// Sessions are numbered by the app; which one runs is `MicrophoneSessions`' decision. The
/// microphone runs only between a start and its stop: the engine is discarded after every
/// dictation, and a prepared engine never opens the device.
final class MicrophoneCapture: @unchecked Sendable {
    enum CaptureError: Error {
        case noInputDevice
        case cannotConvert
    }

    private struct Prepared {
        let engine: AVAudioEngine
        let device: AudioDeviceID
    }

    /// The running session's state, read on the render thread.
    struct TapState {
        let session: Int
        let sampleRate: Double
        var converter: AVAudioConverter?
    }

    /// Receives each converted chunk, with its session, on the audio render thread.
    private let onSamples: @Sendable (Int, [Float]) -> Void
    private let queue = DispatchQueue(label: "ai.tabmail.voice.helper.microphone", qos: .userInitiated)
    /// The running session and its converter, read on the render thread.
    private let tap = OSAllocatedUnfairLock<TapState?>(uncheckedState: nil)
    // Queue-confined.
    private var prepared: Prepared?
    /// The running session's engine; `sessions.running` names its session.
    private var engine: AVAudioEngine?
    private var sessions = MicrophoneSessions()
    private var defaultDeviceListener: AudioObjectPropertyListenerBlock?

    init(onSamples: @escaping @Sendable (Int, [Float]) -> Void) {
        self.onSamples = onSamples
        // The user switched the default input (System Settings › Sound, AirPods connecting…): a
        // prepared engine is bound to the old device, so rebuild it.
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
    func prepare() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                self.prepareOnQueue()
                continuation.resume()
            }
        }
    }

    /// Starts the microphone for `session`, its chunks at `sampleRate`; returns once it runs. Stops an
    /// older session still running. A session already stopped, or older than the one running, is not
    /// started.
    func start(session: Int, sampleRate: Double) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async {
                do {
                    try self.startOnQueue(session: session, sampleRate: sampleRate)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Stops `session` (and any older one) if it runs, and prepares a fresh engine for next time.
    func stop(session: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                if self.sessions.stop(session) { self.stopEngine() }
                self.prepareOnQueue()
                continuation.resume()
            }
        }
    }

    private func startOnQueue(session: Int, sampleRate: Double) throws {
        guard sessions.start(session) else {
            HelperLog.debug("MicrophoneCapture: session \(session) was stopped or superseded before it started")
            return
        }
        stopEngine()
        let current = Self.defaultInputDevice()
        do {
            let engine: AVAudioEngine
            if let prepared, prepared.device == current {
                engine = prepared.engine
            } else {
                engine = try makeEngine()
            }
            prepared = nil
            tap.withLockUnchecked { $0 = TapState(session: session, sampleRate: sampleRate) }
            do {
                try engine.start()
            } catch {
                tap.withLockUnchecked { $0 = nil }
                throw error
            }
            self.engine = engine
        } catch {
            sessions.failed(session)
            throw error
        }
        HelperLog.debug("MicrophoneCapture: session \(session) started")
    }

    private func stopEngine() {
        tap.withLockUnchecked { $0 = nil }
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        HelperLog.debug("MicrophoneCapture: engine stopped")
    }

    private func prepareOnQueue() {
        guard prepared == nil, engine == nil else { return }
        do {
            let device = Self.defaultInputDevice()
            prepared = Prepared(engine: try makeEngine(), device: device)
        } catch {
            HelperLog.error("MicrophoneCapture: prepare failed: \(type(of: error))")
        }
    }

    private func makeEngine() throws -> AVAudioEngine {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError.noInputDevice
        }
        input.installTap(onBus: 0, bufferSize: HelperConfig.microphoneTapBufferSize, format: format) { [weak self] buffer, _ in
            self?.deliver(buffer)
        }
        engine.prepare()
        return engine
    }

    /// Converts a captured buffer for the running session and hands it on. On the render thread.
    private func deliver(_ buffer: AVAudioPCMBuffer) {
        let converted = tap.withLockUnchecked { Self.convert(buffer, for: &$0) }
        if let (session, samples) = converted { onSamples(session, samples) }
    }

    /// `buffer` converted for the session `state` names, with nothing while none runs. Keeps the
    /// converter in `state` for the session's next buffer, which it carries on.
    static func convert(_ buffer: AVAudioPCMBuffer, for state: inout TapState?) -> (Int, [Float])? {
        guard let current = state else { return nil }
        do {
            let (converter, samples) = try convert(buffer, sampleRate: current.sampleRate, converter: current.converter)
            state?.converter = converter
            return (current.session, samples)
        } catch {
            HelperLog.error("MicrophoneCapture: conversion failed: \(type(of: error))")
            return nil
        }
    }

    /// `buffer` as mono float samples at `sampleRate`, all channels mixed down, with the converter to
    /// use for the next buffer.
    static func convert(_ buffer: AVAudioPCMBuffer, sampleRate: Double, converter: AVAudioConverter?) throws -> (AVAudioConverter, [Float]) {
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false) else {
            throw CaptureError.cannotConvert
        }
        let converter = try {
            if let converter, converter.inputFormat == buffer.format, converter.outputFormat == outputFormat { return converter }
            guard let made = AVAudioConverter(from: buffer.format, to: outputFormat) else { throw CaptureError.cannotConvert }
            made.downmix = true
            return made
        }()
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * sampleRate / buffer.format.sampleRate).rounded(.up))
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: max(capacity, 1)) else {
            throw CaptureError.cannotConvert
        }
        let supplied = OSAllocatedUnfairLock(initialState: false)
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
            let wasSupplied = supplied.withLock { value in
                defer { value = true }
                return value
            }
            if wasSupplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            outStatus.pointee = .haveData
            return buffer
        }
        if status == .error { throw conversionError ?? CaptureError.cannotConvert }
        guard let channel = output.floatChannelData?[0] else { throw CaptureError.cannotConvert }
        return (converter, Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength))))
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
}

/// Which of the app's numbered sessions the microphone runs for. The app stops each session before
/// it starts the next, but the helper handles each request in its own task, so they can arrive in
/// any order: a stop stops its own session or an older one, never a newer; and a start the app has
/// already stopped, or older than the one running, does not start.
struct MicrophoneSessions {
    /// The session the microphone runs for.
    private(set) var running: Int?
    private var lastStopped = 0

    /// Whether `session` starts, in place of any older one running.
    mutating func start(_ session: Int) -> Bool {
        guard session > lastStopped, session > (running ?? 0) else { return false }
        running = session
        return true
    }

    /// Whether the running session stops: `session` itself, or an older one.
    mutating func stop(_ session: Int) -> Bool {
        lastStopped = max(lastStopped, session)
        guard let current = running, current <= session else { return false }
        running = nil
        return true
    }

    /// `session`'s start failed: nothing runs, and, as after its stop, no older session starts.
    mutating func failed(_ session: Int) {
        lastStopped = max(lastStopped, session)
        if running == session { running = nil }
    }
}
