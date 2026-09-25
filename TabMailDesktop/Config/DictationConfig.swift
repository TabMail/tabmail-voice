// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import CoreGraphics
import Foundation

/// Every tunable number for the dictation flow lives here (no hardcoded values at call sites).
enum DictationConfig {
    // MARK: Push-to-talk

    /// A hold shorter than this is treated as an accidental tap and discarded.
    static let minimumHoldDuration: Duration = .milliseconds(300)

    // MARK: Audio

    /// Frames per microphone tap callback (~85 ms at 48 kHz).
    static let audioTapBufferSize: AVAudioFrameCount = 4096
    /// RMS → level mapping for the overlay meter: RMS values at or below the floor show as silence.
    static let levelDecibelFloor: Float = -50
    /// Smoothing factor for the overlay level (0 = frozen, 1 = no smoothing).
    static let levelSmoothing: Float = 0.3
    /// Upload format: 16 kHz mono 16-bit PCM WAV — what Whisper-class models consume natively,
    /// at ~32 KB per second of speech.
    static let recordingSampleRate: Double = 16_000
    /// A recording whose loudest buffer stays below this level (same 0…1 scale as the meter) is
    /// treated as silence and not uploaded: Whisper-class models hallucinate text on silence.
    static let silenceLevelThreshold: Float = 0.15
    /// Recording stops and is sent automatically at this length. Must stay under the backend's
    /// upload limit (10 MiB): 5 minutes of 16 kHz 16-bit mono is ~9.6 MB.
    static let maxRecordingDuration: Duration = .seconds(300)

    // MARK: Insertion

    /// How long the target app gets to read the pasteboard before the user's clipboard is restored.
    static let clipboardRestoreDelay: Duration = .milliseconds(500)
    /// Pause between posting the paste keystroke's key-down and key-up events.
    static let pasteKeystrokeGap: Duration = .milliseconds(10)

    // MARK: Backend

    static let productionBackendURL = URL(string: "https://api.tabmail.ai")!
    static let developmentBackendURL = URL(string: "https://dev.tabmail.ai")!
    static let transcribePath = "dictation/transcribe"
    /// Sent as `X-Client-Type` to identify this client to the backend.
    static let clientType = "desktop"
    static let transcriptionRequestTimeout: TimeInterval = 45

    // MARK: Account (Supabase auth at auth.tabmail.ai)

    static let authBaseURL = URL(string: "https://auth.tabmail.ai")!
    /// Supabase publishable key: public by design, shipped in every TabMail client.
    static let authPublishableKey = "sb_publishable_1mtT87g-94P0yxFgM19Itw_P3ih9PUD"
    static let authRequestTimeout: TimeInterval = 15
    /// Refresh the access token when it expires within this many seconds.
    static let tokenRefreshLeewaySeconds = 60
    static let keychainService = "ai.tabmail.desktop.session"

    // MARK: Permissions

    /// While Accessibility is not yet granted, how often to re-check (the grant happens in System Settings).
    static let accessibilityPollInterval: Duration = .seconds(1)

    // MARK: Overlay

    static let overlaySize = CGSize(width: 420, height: 52)
    /// Distance from the bottom of the visible screen area.
    static let overlayBottomInset: CGFloat = 72
    static let overlayHorizontalPadding: CGFloat = 16
    static let overlayContentSpacing: CGFloat = 12
    static let overlayFontSize: CGFloat = 13
    /// Number of bars in the overlay's level meter.
    static let overlayMeterBarCount = 5
    static let overlayMeterBarWidth: CGFloat = 3
    static let overlayMeterBarSpacing: CGFloat = 3
    static let overlayMeterMinBarHeight: CGFloat = 4
    static let overlayMeterMaxBarHeight: CGFloat = 20
    /// Outer bars reach this fraction of the centre bar's height.
    static let overlayMeterEdgeBarWeight: Double = 0.5
    static let overlayMeterAnimation: TimeInterval = 0.08
    /// How long an error message stays on the overlay.
    static let overlayErrorDisplayDuration: Duration = .seconds(3)
}
