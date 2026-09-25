// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Testing
@testable import TabMail

/// Levels from a quiet display microphone, measured: room noise ≈ −45 dB, speech −35 to −40 dB.
struct LevelMeterTests {
    private func settle(_ meter: inout LevelMeter, at decibels: Float, buffers: Int = 20) -> Float {
        var level: Float = 0
        for _ in 0..<buffers { level = meter.level(forDecibels: decibels) }
        return level
    }

    /// The reason for the adaptive meter: on a fixed −50 dB scale this speech showed as ~0.2.
    @Test func quietMicrophoneSpeechFillsTheBars() {
        var meter = LevelMeter()
        #expect(settle(&meter, at: -45) == 0)
        #expect(meter.level(forDecibels: -35) > 0.5)
    }

    @Test func roomNoiseStaysFlat() {
        var meter = LevelMeter()
        for decibels: Float in [-45, -43, -46, -44, -42, -45, -44] {
            #expect(meter.level(forDecibels: decibels) < 0.1)
        }
    }

    @Test func loudMicrophoneSpeechStillScales() {
        var meter = LevelMeter()
        _ = settle(&meter, at: -60)
        #expect(meter.level(forDecibels: -20) == 1)
        let softer = meter.level(forDecibels: -35)
        #expect(softer > 0.3 && softer < 1)
    }

    /// Digital silence while the device starts must not drag the floor so low that room noise
    /// afterwards shows as speech.
    @Test func startUpSilenceDoesNotInflateRoomNoise() {
        var meter = LevelMeter()
        _ = settle(&meter, at: -200, buffers: 5)
        #expect(settle(&meter, at: -45, buffers: 40) < 0.1)
    }
}
