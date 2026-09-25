// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import SwiftUI

struct MenuContent: View {
    let controller: DictationController
    let permissions: PermissionsModel
    let settings: AppSettings
    let account: AccountModel

    var body: some View {
        Text(statusLine)

        if !account.isSignedIn {
            SettingsLink {
                Text("Sign In to TabMail…")
            }
        }
        if permissions.microphone != .authorized {
            Button("Allow Microphone Access…") {
                Task { await permissions.requestMicrophone() }
            }
        }
        if !permissions.accessibilityTrusted {
            Button("Allow Accessibility Access…") {
                permissions.requestAccessibility()
            }
        }

        Divider()

        Button(controller.phase == .listening ? "Stop Dictation" : "Start Dictation") {
            controller.toggle()
        }
        .disabled(!isReady)

        #if DEBUG
        Button("Play Last Recording") {
            NSWorkspace.shared.open(DictationConfig.debugLastRecordingURL)
        }
        .disabled(!FileManager.default.fileExists(atPath: DictationConfig.debugLastRecordingURL.path))
        #endif

        Divider()

        SettingsLink {
            Text("Settings…")
        }
        .keyboardShortcut(",")

        Button("Quit TabMail") {
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q")
    }

    private var isReady: Bool { account.isSignedIn && permissions.allGranted }

    private var statusLine: String {
        if !account.isSignedIn { return "Sign in to start dictating" }
        if !permissions.allGranted { return "Setup needed" }
        return "Hold \(settings.hotkey.displayName) to dictate"
    }
}
