// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import Foundation

/// Every tunable number `voice-microphone` uses on its own. The rest are the app's
/// (`src/core/config.ts`), sent with the requests that need them.
enum HelperConfig {
    /// Frames per captured buffer, at the device's rate (≈ 85 ms at 48 kHz): the Swift app's
    /// `audioTapBufferSize`.
    static let tapBufferSize: AVAudioFrameCount = 4096
    /// How long a stopped engine is kept before it is released, off the capture queue: a Bluetooth
    /// headset changes for about a second as a dictation ends, and a release in that change waits on
    /// the audio system.
    static let engineReleaseDelay: DispatchTimeInterval = .milliseconds(1_500)
}
