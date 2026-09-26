// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import SwiftUI

struct SettingsView: View {
    @Bindable var settings: AppSettings
    let permissions: PermissionsModel
    let account: AccountModel

    var body: some View {
        Form {
            Section("Account") {
                AccountSection(account: account)
            }

            Section("Dictation") {
                Picker("Hold to dictate", selection: $settings.hotkey) {
                    ForEach(DictationHotkey.allCases) { hotkey in
                        Text(hotkey.displayName).tag(hotkey)
                    }
                }
                if settings.hotkey == .function {
                    Text("Set System Settings › Keyboard › “Press 🌐 key to” to “Do Nothing”, or macOS will also open its own picker.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text("Your recording is sent to TabMail for transcription and isn't stored.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Toggle("Read the screen while dictating", isOn: $settings.readsScreen)
                Text("Sends the text in the window in front with your dictation, so names and terms are spelled as they appear there. It isn't stored.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Agent mode") {
                EmailClientPicker(settings: settings)
            }

            Section("Permissions") {
                permissionRow("Microphone", granted: permissions.microphone == .authorized) {
                    Task { await permissions.requestMicrophone() }
                }
                permissionRow("Accessibility (hotkey and typing)", granted: permissions.accessibilityTrusted) {
                    permissions.requestAccessibility()
                }
            }

            Section("General") {
                Toggle("Open at login", isOn: Binding(
                    get: { settings.launchAtLogin },
                    set: { settings.setLaunchAtLogin($0) }
                ))
                Toggle("Use development server", isOn: $settings.useDevelopmentServer)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .fixedSize()
        .onAppear { permissions.refresh() }
    }

    private func permissionRow(_ title: String, granted: Bool, request: @escaping () -> Void) -> some View {
        LabeledContent(title) {
            if granted {
                Label("Allowed", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Button("Allow…", action: request)
            }
        }
    }
}

/// Which email app mail and calendar requests go to: the default email app, or a Thunderbird
/// installed on this Mac.
private struct EmailClientPicker: View {
    @Bindable var settings: AppSettings

    private let systemDefault = EmailClient.systemDefault()
    private let installed = EmailClient.installed()

    private var defaultIsSupported: Bool {
        EmailClient.resolve(chosen: nil, systemDefault: systemDefault?.bundleIdentifier) != nil
    }

    var body: some View {
        Picker("Email app", selection: $settings.emailClient) {
            Text("Default (\(systemDefault?.name ?? "none"))").tag(String?.none)
            ForEach(installed, id: \.bundleIdentifier) { app in
                Text(app.name).tag(Optional(app.bundleIdentifier))
            }
        }
        if settings.emailClient == nil, !defaultIsSupported {
            Text("Mail and calendar requests need Thunderbird with TabMail. Choose it here, or make it your default email app.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Text("Mail and calendar requests go to TabMail's chat in this app.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// Email-code sign-in for an existing TabMail account.
private struct AccountSection: View {
    let account: AccountModel

    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        if let signedInEmail = account.email {
            LabeledContent("Signed in as", value: signedInEmail)
            Button("Sign Out") { account.signOut() }
        } else if codeSent {
            Text("Enter the code we emailed to \(email).")
            TextField("Code", text: $code)
                .textContentType(.oneTimeCode)
                .onSubmit(verify)
            HStack {
                Button("Use a Different Email") {
                    codeSent = false
                    code = ""
                    errorMessage = nil
                }
                Spacer()
                Button("Sign In", action: verify)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || code.isEmpty)
            }
            errorText
        } else {
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .onSubmit(sendCode)
            HStack {
                Spacer()
                Button("Email Me a Code", action: sendCode)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || !email.contains("@"))
            }
            errorText
        }
    }

    @ViewBuilder
    private var errorText: some View {
        if let errorMessage {
            Text(errorMessage)
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    private func sendCode() {
        run {
            try await account.sendCode(to: email)
            codeSent = true
        }
    }

    private func verify() {
        run {
            try await account.verify(email: email, code: code)
            code = ""
            codeSent = false
        }
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        busy = true
        errorMessage = nil
        Task {
            do {
                try await work()
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}
