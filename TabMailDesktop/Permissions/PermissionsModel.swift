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
    private(set) var microphone: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .audio)
    private(set) var accessibilityTrusted: Bool = AXIsProcessTrusted()

    /// Fires once when Accessibility flips to granted, so the hotkey monitor can be re-installed.
    @ObservationIgnored var onAccessibilityGranted: (() -> Void)?
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    var allGranted: Bool { microphone == .authorized && accessibilityTrusted }

    func refresh() {
        microphone = AVCaptureDevice.authorizationStatus(for: .audio)
        let trusted = AXIsProcessTrusted()
        if trusted, !accessibilityTrusted { onAccessibilityGranted?() }
        accessibilityTrusted = trusted
    }

    func requestMicrophone() async {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
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
