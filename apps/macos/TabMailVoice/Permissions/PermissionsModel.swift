// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import AVFoundation
import Observation

/// The two grants dictation needs: Microphone (to hear) and Accessibility (to see the hotkey
/// system-wide and to paste into other apps).
@MainActor
@Observable
final class PermissionsModel {
    private(set) var microphone: AVAuthorizationStatus
    private(set) var accessibilityTrusted: Bool

    /// Fires once when Accessibility flips to granted, so the hotkey monitor can be re-installed.
    @ObservationIgnored var onAccessibilityGranted: (() -> Void)?
    /// Fires once when Microphone flips to granted (the model already reports it), so the
    /// microphone can be prepared ahead of the first dictation.
    @ObservationIgnored var onMicrophoneGranted: (() -> Void)?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private let readMicrophone: () -> AVAuthorizationStatus
    @ObservationIgnored private let readAccessibility: () -> Bool

    /// Reads the grants from the system; tests pass their own readers.
    init(
        readMicrophone: @escaping () -> AVAuthorizationStatus = { AVCaptureDevice.authorizationStatus(for: .audio) },
        readAccessibility: @escaping () -> Bool = { AXIsProcessTrusted() }
    ) {
        self.readMicrophone = readMicrophone
        self.readAccessibility = readAccessibility
        microphone = readMicrophone()
        accessibilityTrusted = readAccessibility()
    }

    var allGranted: Bool { microphone == .authorized && accessibilityTrusted }

    func refresh() {
        let wasMicrophoneAuthorized = microphone == .authorized
        microphone = readMicrophone()
        if microphone == .authorized, !wasMicrophoneAuthorized { onMicrophoneGranted?() }
        let trusted = readAccessibility()
        if trusted, !accessibilityTrusted { onAccessibilityGranted?() }
        accessibilityTrusted = trusted
    }

    func requestMicrophone() async {
        switch readMicrophone() {
        case .notDetermined:
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            open(settingsAnchor: "Privacy_Microphone")
        default:
            break
        }
        refresh()
    }

    /// Shows the system Accessibility prompt, then watches for the grant in System Settings.
    func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) {
            open(settingsAnchor: "Privacy_Accessibility")
        }
        startPollingAccessibility()
    }

    func startPollingAccessibility() {
        guard !accessibilityTrusted, pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: DictationConfig.accessibilityPollInterval)
                guard let self else { return }
                self.refresh()
                if self.accessibilityTrusted {
                    self.pollTask = nil
                    return
                }
            }
        }
    }

    private func open(settingsAnchor: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(settingsAnchor)") else { return }
        NSWorkspace.shared.open(url)
    }
}
