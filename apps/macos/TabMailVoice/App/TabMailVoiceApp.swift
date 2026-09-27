// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

@main
struct TabMailVoiceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(controller: appDelegate.controller, permissions: appDelegate.permissions, settings: appDelegate.settings, account: appDelegate.account, showWelcome: appDelegate.showWelcome)
        } label: {
            Image("MenuBarIcon")
                .accessibilityLabel("TabMail Voice")
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
    let contextProbe: ScreenContextProbe
    let controller: DictationController
    private let welcome: WelcomeWindowController
    private var hotkeyMonitor: HotkeyMonitor?
    private var overlay: OverlayPanelController?
    private let accessibilityActivator = AccessibilityActivator()

    override init() {
        let settings = settings
        let account = account
        contextProbe = ScreenContextProbe()
        welcome = WelcomeWindowController(settings: settings, permissions: permissions)
        controller = DictationController(
            permissions: permissions,
            settings: { settings.dictation(for: account.email) },
            account: account,
            tips: TipBook(defaults: .standard),
            thunderbird: ThunderbirdRelay(system: .live()),
            makeTranscriptionClient: { TranscriptionClient(baseURL: $0) },
            makeCompletionsClient: { CompletionsClient(baseURL: $0) }
        )
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The unit-test bundle is hosted in this app; don't raise permission prompts or grab
        // the keyboard while tests run.
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }

        let overlay = OverlayPanelController(controller: controller)
        self.overlay = overlay
        controller.captureContext = { [contextProbe] in contextProbe.capture() }

        let monitor = HotkeyMonitor(hotkey: settings.hotkey) { [weak self] action in
            self?.controller.handle(action)
        }
        hotkeyMonitor = monitor
        controller.onPhaseChange = { phase in
            overlay.update(for: phase)
            switch phase {
            case .arming, .listening: break
            // Finished, failed or cancelled without the hotkey: hands-free listening is over too.
            case .idle, .transcribing, .running, .failed: monitor.dictationEnded()
            }
        }
        monitor.install()
        settings.onHotkeyChange = { monitor.setHotkey($0) }
        // The keyboard event tap can't be created until Accessibility is granted: install again
        // once the grant lands.
        permissions.onAccessibilityGranted = { [accessibilityActivator] in
            monitor.install()
            accessibilityActivator.start()
        }
        accessibilityActivator.start()
        permissions.onMicrophoneGranted = { [controller] in controller.prewarm() }
        permissions.startPollingAccessibility()
        controller.prewarm()

        // The welcome wizard asks for consent and the permissions; it opens until finished.
        if !settings.hasFinishedWelcome {
            welcome.show()
        }
    }

    func showWelcome() {
        welcome.show()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        permissions.refresh()
    }
}
