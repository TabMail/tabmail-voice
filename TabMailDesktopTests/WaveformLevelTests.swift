// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Testing
@testable import TabMail

/// The waveform shows that sound is coming in, on a fixed sensitive scale. Levels measured on a
/// quiet display microphone: room noise ≈ −45 dB, short utterances ≈ −42 dB, speech −35 to −40 dB.
struct WaveformLevelTests {
    @Test func anySoundOnAQuietMicMovesTheWaveform() {
        #expect(MicrophoneCapture.level(forDecibels: -45) > 0.3)
        #expect(MicrophoneCapture.level(forDecibels: -35) > MicrophoneCapture.level(forDecibels: -45))
    }

    @Test func silenceIsFlatAndLoudIsFull() {
        #expect(MicrophoneCapture.level(forDecibels: DictationConfig.silenceDecibels) == 0)
        #expect(MicrophoneCapture.level(forDecibels: -10) == 1)
    }
}
