// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Adapts the waveform to the range of sound coming in, so it follows the voice on any
/// microphone: two exponential-moving-average envelopes of the loudness (dB). The floor follows
/// quieter readings fast and louder ones slowly; the peak follows louder readings fast and
/// quieter ones slowly. Each reading shows where it sits between them.
struct LevelEnvelope {
    private var floor: Float?
    private var peak: Float?

    mutating func level(forDecibels decibels: Float) -> Float {
        let floor = Self.follow(floor ?? decibels, to: decibels, fastWhenBelow: true)
        let peak = Self.follow(peak ?? decibels, to: decibels, fastWhenBelow: false)
        self.floor = floor
        self.peak = peak
        let top = max(peak, floor + DictationConfig.envelopeMinimumRange)
        return max(0, min(1, (decibels - floor) / (top - floor)))
    }

    private static func follow(_ value: Float, to reading: Float, fastWhenBelow: Bool) -> Float {
        let fast = (reading < value) == fastWhenBelow
        let alpha = fast ? DictationConfig.envelopeFastAlpha : DictationConfig.envelopeSlowAlpha
        return value + (reading - value) * alpha
    }
}
