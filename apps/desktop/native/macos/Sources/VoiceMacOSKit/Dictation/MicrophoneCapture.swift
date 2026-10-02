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
/// dictation, and a prepared engine never opens the device. A running engine that stops by itself
/// (the input's format changed: AVAudioEngine stops on a configuration change) is that session's
/// microphone lost, told to `onLost`.
///
/// The input device can be changing at any time (the default input switched, AirPods connecting or
/// changing to their microphone mode as a dictation starts and back as it ends). Releasing an
/// engine then raced AVFAudio's own listener for it, and building one raised an Objective-C
/// exception in `installTap`, which Swift cannot catch, both ending the helper; either could also
/// hold the capture queue, and every start and stop behind it, for minutes. So no engine is ever
/// released on the capture queue: each is stopped there and released later on a queue of its own
/// (`retire`). And after a change the helper sees (the default input, a running engine's format),
/// the next engine is prepared only once the changes have stopped for
/// `HelperConfig.microphoneDeviceSettleDelay`. A start in that window builds its own engine, as it
/// does whenever none is prepared for the current device.
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
    /// Receives the session whose microphone stopped by itself, on the capture queue.
    private let onLost: @Sendable (Int) -> Void
    private let queue = DispatchQueue(label: "ai.tabmail.voice.helper.microphone", qos: .userInitiated)
    /// The running session and its converter, read on the render thread.
    private let tap = OSAllocatedUnfairLock<TapState?>(uncheckedState: nil)
    // Queue-confined.
    private var prepared: Prepared?
    /// The running session's engine; `sessions.running` names its session.
    private var engine: AVAudioEngine?
    private var sessions = MicrophoneSessions()
    private var inputChanges = InputChanges()
    /// Where engines are released: releasing one waits on the audio system, which must not hold up
    /// a start.
    private let retireQueue = DispatchQueue(label: "ai.tabmail.voice.helper.microphoneRetire", qos: .utility)
    private var defaultDeviceListener: AudioObjectPropertyListenerBlock?
    /// Watches the running engine for a configuration change.
    private var configurationObserver: NSObjectProtocol?

    init(onSamples: @escaping @Sendable (Int, [Float]) -> Void, onLost: @escaping @Sendable (Int) -> Void) {
        self.onSamples = onSamples
        self.onLost = onLost
        // The user switched the default input (System Settings › Sound, AirPods connecting…): a
        // prepared engine is bound to the old device, so rebuild it, once the device has settled.
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            HelperLog.debug("MicrophoneCapture: the default input changed")
            self.inputChangedOnQueue()
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
                if let prepared { retire(prepared.engine) }
                HelperLog.debug("MicrophoneCapture: no engine prepared for device \(current); building one")
                engine = try makeEngine()
            }
            prepared = nil
            tap.withLockUnchecked { $0 = TapState(session: session, sampleRate: sampleRate) }
            // Watched before it starts, so a change as it starts is not missed (handled on this queue,
            // once the engine is `self.engine`). Weakly: the notification's queue must not hold the
            // last reference to the engine.
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self, weak engine] _ in
                guard let self else { return }
                self.queue.async { [weak engine] in
                    if let engine { self.engineStoppedOnQueue(engine) }
                }
            }
            do {
                try engine.start()
            } catch {
                tap.withLockUnchecked { $0 = nil }
                if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
                configurationObserver = nil
                retire(engine)
                throw error
            }
            self.engine = engine
        } catch {
            sessions.failed(session)
            throw error
        }
        HelperLog.debug("MicrophoneCapture: session \(session) started")
    }

    /// `stopped` stopped by itself: if it still runs a session, that session's microphone is lost.
    private func engineStoppedOnQueue(_ stopped: AVAudioEngine) {
        guard stopped === engine, let session = sessions.lost() else { return }
        HelperLog.error("MicrophoneCapture: session \(session) lost: the input's configuration changed")
        stopEngine()
        inputChangedOnQueue()
        onLost(session)
    }

    /// The input device changed: the engine prepared for it is retired, and the next is prepared
    /// once no further change has come for `microphoneDeviceSettleDelay` (a device arriving changes
    /// several times over).
    private func inputChangedOnQueue() {
        if let prepared { retire(prepared.engine) }
        prepared = nil
        let change = inputChanges.changed()
        queue.asyncAfter(deadline: .now() + HelperConfig.microphoneDeviceSettleDelay) { [weak self] in
            guard let self, self.inputChanges.settled(change) else { return }
            self.prepareOnQueue()
        }
    }

    /// Releases an engine `microphoneDeviceSettleDelay` from now, off the capture queue.
    private func retire(_ engine: AVAudioEngine) {
        let retired = Retired(engine: engine)
        retireQueue.asyncAfter(deadline: .now() + HelperConfig.microphoneDeviceSettleDelay) {
            retired.release()
        }
    }

    /// Stops the running engine, so the microphone is off; the engine itself is released later.
    private func stopEngine() {
        tap.withLockUnchecked { $0 = nil }
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        retire(engine)
        HelperLog.debug("MicrophoneCapture: engine stopped")
    }

    /// Prepares an engine for the next start, unless one is prepared or running, or the input device
    /// is still changing (the settle prepares then).
    private func prepareOnQueue() {
        guard prepared == nil, engine == nil, !inputChanges.settling else { return }
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
        // no sample rate or channels (no input, or one still arriving).
        let hardware = input.inputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
            retire(engine)
            throw CaptureError.noInputDevice
        }
        HelperLog.debug("MicrophoneCapture: input at \(Int(hardware.sampleRate)) Hz, \(hardware.channelCount) channel(s)")
        // No format given: the tap takes the node's own. One read here and passed in can already
        // differ from the device's by the time it is installed, which raises the same exception.
        input.installTap(onBus: 0, bufferSize: HelperConfig.microphoneTapBufferSize, format: nil) { [weak self] buffer, _ in
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

/// An engine on its way out, carried to the queue that releases it.
private final class Retired: @unchecked Sendable {
    private var engine: AVAudioEngine?

    init(engine: AVAudioEngine) {
        self.engine = engine
    }

    /// Releases the engine, on the caller's thread. Called once.
    func release() {
        engine = nil
    }
}

/// Whether the input device is still changing. A device arriving changes several times in a row;
/// each change is numbered, and only the latest one's wait settles it.
struct InputChanges {
    private var latest = 0
    /// A change came and its wait has not ended.
    private(set) var settling = false

    /// A change came; returns its number, for `settled`.
    mutating func changed() -> Int {
        latest += 1
        settling = true
        return latest
    }

    /// `change`'s wait ended. Whether the device has settled: no later change came.
    mutating func settled(_ change: Int) -> Bool {
        guard change == latest else { return false }
        settling = false
        return true
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

    /// The running session's microphone stopped by itself: nothing runs, and, as after its stop, no
    /// older session starts. Returns that session, nil when none ran.
    mutating func lost() -> Int? {
        guard let current = running else { return nil }
        failed(current)
        return current
    }

    /// `session`'s start failed: nothing runs, and, as after its stop, no older session starts.
    mutating func failed(_ session: Int) {
        lastStopped = max(lastStopped, session)
        if running == session { running = nil }
    }
}
