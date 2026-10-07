// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import CVoiceCore
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
/// microphone runs only between a start and its stop, and a prepared engine never opens the device.
///
/// One engine per process: after its engine has run (a session stopped) or failed to start, when
/// the default input changes (System Settings › Sound, AirPods connecting or switched off), or when
/// the running engine stops by itself (AVAudioEngine stops when its input's format changes),
/// `onEnd` is told and the process is expected to end; the app starts the helper afresh, which
/// prepares the next engine, and a dictation that was running ends as the helper's exit ends it.
/// A second engine in the same process did not work: with a Bluetooth headset, which changes mode
/// as a dictation ends, the engine prepared after a stop lost its configuration as it started,
/// every other dictation; an engine bound to a device that went away rebinds itself inside
/// AVFAudio, and building, starting or releasing any engine meanwhile waited on the audio system
/// for up to minutes (one build took 64 s after AirPods were switched off), raised an Objective-C
/// exception in `installTap`, or crashed in AVFAudio's own listener. So nothing here reacts to a
/// change but by saying so, from a queue no engine work runs on, and no engine that was prepared
/// or ran is released here: the process ending releases it. (One built for an input with no
/// format, which never had a tap, is dropped at once.)
final class MicrophoneCapture: @unchecked Sendable {
    enum CaptureError: Error {
        case noInputDevice
        case cannotConvert
        /// This process's engine has started, or was prepared for another device: the start is
        /// for a fresh process.
        case engineUsed
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
    /// Told that the process should end (its engine ran or failed, or the input changed). Not on
    /// the capture queue when the input changed, as an engine may be holding it.
    private let onEnd: @Sendable () -> Void
    /// Where the default input's changes arrive.
    private let changeQueue = DispatchQueue(label: "ai.tabmail.voice.helper.microphoneChanges", qos: .userInitiated)
    private let queue = DispatchQueue(label: "ai.tabmail.voice.helper.microphone", qos: .userInitiated)
    /// The running session and its converter, read on the render thread.
    private let tap = OSAllocatedUnfairLock<TapState?>(uncheckedState: nil)
    // Queue-confined.
    private var prepared: Prepared?
    /// The running session's engine; `sessions.running` names its session.
    private var engine: AVAudioEngine?
    /// The engine that ran, kept until the process ends: releasing it while a headset changes waits
    /// on the audio system, and would hold up the process's end.
    private var stopped: AVAudioEngine?
    private var sessions = MicrophoneSessions()
    private var defaultDeviceListener: AudioObjectPropertyListenerBlock?
    /// Watches the running engine for a configuration change (it stopped by itself).
    private var configurationObserver: NSObjectProtocol?

    init(onSamples: @escaping @Sendable (Int, [Float]) -> Void, onEnd: @escaping @Sendable () -> Void) {
        self.onSamples = onSamples
        self.onEnd = onEnd
        let listener: AudioObjectPropertyListenerBlock = { _, _ in
            HelperLog.debug("MicrophoneCapture: the default input changed")
            onEnd()
        }
        var address = Self.defaultInputAddress
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, changeQueue, listener)
        defaultDeviceListener = listener
    }

    deinit {
        if let defaultDeviceListener {
            var address = Self.defaultInputAddress
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, changeQueue, defaultDeviceListener)
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

    /// Stops `session` (and any older one) if it runs; the process then ends, and the next engine
    /// is prepared in the one started in its place.
    func stop(session: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                if self.sessions.stop(session) {
                    self.stopEngine()
                    self.onEnd()
                }
                continuation.resume()
            }
        }
    }

    private func startOnQueue(session: Int, sampleRate: Double) throws {
        switch sessions.start(session) {
        case .skipped:
            HelperLog.debug("MicrophoneCapture: session \(session) was stopped or superseded before it started")
            return
        case .endsProcess:
            HelperLog.debug("MicrophoneCapture: session \(session) asked after this process's engine started; ending")
            stopEngine()
            onEnd()
            throw CaptureError.engineUsed
        case .runs:
            break
        }
        let current = Self.defaultInputDevice()
        do {
            let engine: AVAudioEngine
            if let prepared {
                // Prepared for another device: the input changed, and the process is ending.
                guard prepared.device == current else { throw CaptureError.engineUsed }
                engine = prepared.engine
            } else {
                HelperLog.debug("MicrophoneCapture: no engine prepared for device \(current); building one")
                engine = try makeEngine()
            }
            prepared = nil
            tap.withLockUnchecked { $0 = TapState(session: session, sampleRate: sampleRate) }
            // Watched before it starts, so a change as it starts is not missed. Only the running
            // engine is watched (the observer is removed as it stops), and the notification names it
            // without being handed it: nothing here may hold the engine.
            let onEnd = self.onEnd
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
                HelperLog.error("MicrophoneCapture: session \(session) lost: the input's configuration changed")
                onEnd()
            }
            do {
                try engine.start()
            } catch {
                tap.withLockUnchecked { $0 = nil }
                if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
                configurationObserver = nil
                // Kept, as a stopped engine is: the process ends with it.
                stopped = engine
                throw error
            }
            self.engine = engine
        } catch {
            sessions.failed(session)
            // A start the app tries again goes to a fresh process.
            onEnd()
            throw error
        }
        HelperLog.debug("MicrophoneCapture: session \(session) started")
    }

    /// Stops the running engine, if any, so the microphone is off. The engine is kept: the process
    /// ends with it.
    private func stopEngine() {
        tap.withLockUnchecked { $0 = nil }
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        stopped = engine
        self.engine = nil
        HelperLog.debug("MicrophoneCapture: engine stopped")
    }

    /// Prepares the process's engine, unless one is prepared or has started.
    private func prepareOnQueue() {
        guard prepared == nil, sessions.mayPrepare else { return }
        do {
            let device = Self.defaultInputDevice()
            let began = ContinuousClock.now
            prepared = Prepared(engine: try makeEngine(), device: device)
            HelperLog.debug("MicrophoneCapture: prepared for device \(device) (\(Self.transportName(Self.transport(of: device)))) in \((ContinuousClock.now - began).formatted(.units(allowed: [.milliseconds])))")
        } catch {
            HelperLog.error("MicrophoneCapture: prepare failed: \(type(of: error))")
        }
    }

    private func makeEngine() throws -> AVAudioEngine {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // The device's own format: `installTap` raises an exception Swift cannot catch when it has
        // no sample rate or channels (no input).
        let hardware = input.inputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else { throw CaptureError.noInputDevice }
        HelperLog.debug("MicrophoneCapture: input at \(Int(hardware.sampleRate)) Hz, \(hardware.channelCount) channel(s)")
        // No format given: the tap takes the node's own. One read here and passed in can already
        // differ from the device's by the time it is installed, which raises the same exception.
        input.installTap(onBus: 0, bufferSize: HelperConfig.tapBufferSize, format: nil) { [weak self] buffer, _ in
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

    /// How `device` is connected (`kAudioDevicePropertyTransportType`), 0 when it does not say.
    private static func transport(of device: AudioDeviceID) -> UInt32 {
        var transport = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport)
        return transport
    }

    /// A transport type for the log: its four characters ("blue", "usb", "bltn"), which name no
    /// device; "unknown" when they are not printable.
    static func transportName(_ transport: UInt32) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8(truncatingIfNeeded: transport >> $0) }
        guard bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) else { return "unknown" }
        return String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespaces)
    }
}

/// Which of the app's numbered sessions the microphone runs for, and when the process ends: the
/// shared core's decision (`native/shared/rust/src/microphone.rs`, its cases in
/// `native/shared/microphone/session-cases.json`), the same in every `voice-microphone`.
struct MicrophoneSessions {
    enum Start: Equatable {
        /// The engine starts for the session.
        case runs
        /// Already stopped or superseded: nothing happens.
        case skipped
        /// The process's engine has started: any running session stops, and the process ends.
        case endsProcess
    }

    private var state = VoiceMicrophoneSessions()

    /// The session the microphone runs for.
    var running: Int? {
        var state = state
        let session = voice_core_microphone_running(&state)
        return session == 0 ? nil : Int(session)
    }

    /// Whether the engine may be prepared: it has not started.
    var mayPrepare: Bool {
        var state = state
        return voice_core_microphone_may_prepare(&state) != 0
    }

    mutating func start(_ session: Int) -> Start {
        switch voice_core_microphone_start(&state, Int64(session)) {
        case UInt32(VoiceMicrophoneRuns.rawValue): .runs
        case UInt32(VoiceMicrophoneEndsProcess.rawValue): .endsProcess
        default: .skipped
        }
    }

    /// Whether the running session stops, `session` itself or an older one, which ends the process.
    mutating func stop(_ session: Int) -> Bool {
        voice_core_microphone_stop(&state, Int64(session)) != 0
    }

    /// `session`'s start failed: nothing runs, no older session starts, and the process ends.
    mutating func failed(_ session: Int) {
        voice_core_microphone_failed(&state, Int64(session))
    }
}
