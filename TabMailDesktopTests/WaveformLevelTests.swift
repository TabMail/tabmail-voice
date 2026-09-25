// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Testing
@testable import TabMail

/// Levels measured on a quiet display microphone: room noise ≈ −45 dB, speech −35 to −40 dB.
struct WaveformLevelTests {
    private let loudEnd = DictationConfig.levelMinimumLoudDecibels

    /// The waveform must follow speech, not sit near full on background: speech well above the
    /// room noise, room noise low but visible.
    @Test func quietMicSpeechStandsOutFromRoomNoise() {
        let noise = MicrophoneCapture.level(forDecibels: -45, loudest: -45)
        let speech = MicrophoneCapture.level(forDecibels: -36, loudest: -36)
        #expect(noise > 0 && noise < 0.35)
        #expect(speech > 0.6)
        #expect(speech - noise > 0.35)
    }

    /// A louder microphone's speech must not pin the bars at full: the loud end follows it.
    @Test func loudMicSpeechStillVaries() {
        let peak = MicrophoneCapture.level(forDecibels: -15, loudest: -15)
        let softer = MicrophoneCapture.level(forDecibels: -25, loudest: -15)
        #expect(peak == 1)
        #expect(softer > 0.3 && softer < 0.85)
    }

    @Test func silenceIsFlat() {
        #expect(MicrophoneCapture.level(forDecibels: DictationConfig.silenceDecibels, loudest: loudEnd) == 0)
    }
}
