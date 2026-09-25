// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Maps microphone loudness to the overlay waveform's 0…1 level, relative to this microphone and
/// room rather than a fixed decibel scale: built-in and display microphones can deliver speech
/// only ~10 dB above the room noise, which a fixed scale shows as barely moving bars.
///
/// Tracks the room-noise floor (follows drops at once, rises slowly so pauses between words
/// re-anchor it) and the speaking ceiling (follows peaks at once, decays slowly), and shows where
/// each buffer sits between them. Room noise stays near zero; speech fills the bars.
struct LevelMeter {
    private var floor: Float?
    private var ceiling: Float?

    mutating func level(forDecibels input: Float) -> Float {
        let decibels = max(input, DictationConfig.meterSilenceDecibels)
        let floor = min(decibels, (self.floor ?? decibels) + DictationConfig.meterFloorRisePerBuffer)
        let ceiling = max(
            decibels,
            (self.ceiling ?? decibels) - DictationConfig.meterCeilingFallPerBuffer,
            floor + DictationConfig.meterMinimumRange
        )
        self.floor = floor
        self.ceiling = ceiling
        let bottom = floor + DictationConfig.meterNoiseMargin
        return max(0, min(1, (decibels - bottom) / (ceiling - bottom)))
    }
}
