// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

/// Opens the welcome wizard in its own window, starting at the first step; brings the open one
/// forward instead of opening a second.
@MainActor
final class WelcomeWindowController {
    private let settings: AppSettings
    private let permissions: PermissionsModel
    private var window: NSWindow?

    init(settings: AppSettings, permissions: PermissionsModel) {
        self.settings = settings
        self.permissions = permissions
    }

    func show() {
        // A menu-bar app isn't active on its own, so its window would open behind the frontmost app.
        NSApp.activate()
        if let window, window.isVisible {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let wizard = WelcomeWizard(settings: settings)
        let window = NSWindow(contentViewController: NSHostingController(
            rootView: WelcomeView(wizard: wizard, settings: settings, permissions: permissions)
        ))
        window.title = "Welcome to TabMail"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        wizard.onFinish = { [weak window] in window?.close() }
        window.center()
        self.window = window
        window.makeKeyAndOrderFront(nil)
    }
}
