// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

@main
struct TabMailDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(controller: appDelegate.controller, permissions: appDelegate.permissions, settings: appDelegate.settings, account: appDelegate.account)
        } label: {
            Image(systemName: menuBarSymbol)
        }

        Settings {
            SettingsView(settings: appDelegate.settings, permissions: appDelegate.permissions, account: appDelegate.account)
        }
    }

    private var menuBarSymbol: String {
        switch appDelegate.controller.phase {
        case .listening: "waveform"
        case .transcribing: "ellipsis"
        case .failed: "exclamationmark.triangle"
        case .idle: appDelegate.permissions.allGranted && appDelegate.account.isSignedIn ? "mic" : "mic.slash"
        }
    }
}

/// Owns the long-lived objects and wires them together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let permissions = PermissionsModel()
    let settings = AppSettings()
    let account = AccountModel()
    let controller: DictationController
    private var hotkeyMonitor: HotkeyMonitor?
    private var overlay: OverlayPanelController?

    override init() {
        let settings = settings
        controller = DictationController(permissions: permissions, account: account) {
            TranscriptionClient(baseURL: settings.backendURL)
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The unit-test bundle is hosted in this app; don't raise permission prompts or grab
        // the keyboard while tests run.
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }

        let overlay = OverlayPanelController(controller: controller)
        self.overlay = overlay
        controller.onPhaseChange = { overlay.update(for: $0) }

        let monitor = HotkeyMonitor(hotkey: settings.hotkey) { [weak self] action in
            self?.controller.handle(action)
        }
        hotkeyMonitor = monitor
        monitor.install()
        settings.onHotkeyChange = { monitor.setHotkey($0) }
        // Global key monitors deliver nothing until Accessibility is granted, and do not
        // start retroactively: re-install once the grant lands.
        permissions.onAccessibilityGranted = { monitor.install() }

        Task {
            if permissions.microphone == .notDetermined {
                await permissions.requestMicrophone()
            }
            if !permissions.accessibilityTrusted {
                permissions.requestAccessibility()
            }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        permissions.refresh()
    }
}
