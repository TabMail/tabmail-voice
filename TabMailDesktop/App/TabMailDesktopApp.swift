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
            Image("MenuBarIcon")
                .accessibilityLabel("TabMail")
        }

        Settings {
            SettingsView(settings: appDelegate.settings, permissions: appDelegate.permissions, account: appDelegate.account)
        }

        #if DEBUG
        Window("Last Screen Context", id: ScreenContextDebugView.windowID) {
            ScreenContextDebugView(probe: appDelegate.contextProbe)
        }
        #endif
    }
}

/// Owns the long-lived objects and wires them together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let permissions = PermissionsModel()
    let settings = AppSettings()
    let account = AccountModel()
    let contextProbe = ScreenContextProbe()
    let controller: DictationController
    private var hotkeyMonitor: HotkeyMonitor?
    private var overlay: OverlayPanelController?
    private let accessibilityActivator = AccessibilityActivator()

    override init() {
        let settings = settings
        controller = DictationController(
            permissions: permissions,
            account: account,
            makeTranscriptionClient: { TranscriptionClient(baseURL: settings.backendURL) },
            makeCompletionsClient: { CompletionsClient(baseURL: settings.backendURL) }
        )
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The unit-test bundle is hosted in this app; don't raise permission prompts or grab
        // the keyboard while tests run.
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }

        let overlay = OverlayPanelController(controller: controller)
        self.overlay = overlay
        controller.onPhaseChange = { overlay.update(for: $0) }
        controller.captureContext = { [contextProbe] in contextProbe.capture() }

        let monitor = HotkeyMonitor(hotkey: settings.hotkey) { [weak self] action in
            self?.controller.handle(action)
        }
        hotkeyMonitor = monitor
        monitor.install()
        settings.onHotkeyChange = { monitor.setHotkey($0) }
        // Global key monitors deliver nothing until Accessibility is granted, and do not
        // start retroactively: re-install once the grant lands.
        permissions.onAccessibilityGranted = { [accessibilityActivator] in
            monitor.install()
            accessibilityActivator.start()
        }
        accessibilityActivator.start()

        Task {
            if permissions.microphone == .notDetermined {
                await permissions.requestMicrophone()
            }
            controller.prewarm()
            if !permissions.accessibilityTrusted {
                permissions.requestAccessibility()
            }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        permissions.refresh()
    }
}
