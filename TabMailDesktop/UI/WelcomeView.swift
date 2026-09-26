// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

/// The welcome wizard's window content: the top rail, the current step, and Back / Next.
struct WelcomeView: View {
    let wizard: WelcomeWizard
    @Bindable var settings: AppSettings
    let permissions: PermissionsModel

    var body: some View {
        VStack(spacing: 0) {
            WelcomeRail(wizard: wizard)
                .padding(.vertical, 20)
            Divider()
            page
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(28)
            Divider()
            HStack {
                Button("Back", action: wizard.back)
                    .disabled(wizard.isFirstStep)
                Spacer()
                Button(wizard.isLastStep ? "Finish" : "Next", action: wizard.next)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!wizard.canAdvance)
            }
            .padding(16)
        }
        .frame(width: DictationConfig.welcomeWindowSize.width, height: DictationConfig.welcomeWindowSize.height)
        .onAppear { permissions.refresh() }
    }

    @ViewBuilder
    private var page: some View {
        switch wizard.step {
        case .consent: consentPage
        case .microphone: microphonePage
        case .accessibility: accessibilityPage
        case .screenReading: screenReadingPage
        }
    }

    private var consentPage: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: DictationConfig.welcomeIconSize, height: DictationConfig.welcomeIconSize)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Welcome to TabMail").font(.title2.bold())
                    Text("Hold a key, speak, and TabMail types what you said.")
                        .foregroundStyle(.secondary)
                }
            }
            Text("To do that, TabMail sends:")
            VStack(alignment: .leading, spacing: 10) {
                Label("Your voice, while you hold the dictation key, to turn it into text.", systemImage: "mic")
                Label("The text in the window in front, with the app's name, the window's title, the website's address and the program running in a terminal, so names and terms are spelled as they appear there. This is screen reading: it's on unless you switch it off in the Features step or in Settings.", systemImage: "text.viewfinder")
                Label("Both go to TabMail and the AI providers it uses, only to process that dictation, and aren't stored.", systemImage: "lock.shield")
            }
            .fixedSize(horizontal: false, vertical: true)
            Toggle("I agree to the Terms of Service and the Privacy Policy.", isOn: $settings.hasConsented)
                .toggleStyle(.checkbox)
            HStack(spacing: 16) {
                Link("Terms of Service", destination: DictationConfig.termsURL)
                Link("Privacy Policy", destination: DictationConfig.privacyURL)
            }
            .font(.callout)
        }
    }

    private var microphonePage: some View {
        stepPage(
            title: "Microphone",
            systemImage: "mic",
            text: "TabMail listens only while you hold the dictation key, and turns the microphone off when you let go."
        ) {
            grantRow(granted: permissions.microphone == .authorized, button: "Allow Microphone Access") {
                Task { await permissions.requestMicrophone() }
            }
        }
    }

    private var accessibilityPage: some View {
        stepPage(
            title: "Accessibility",
            systemImage: "accessibility",
            text: "Lets TabMail notice the dictation key in any app and type the text where your cursor is. Screen reading uses it too."
        ) {
            grantRow(granted: permissions.accessibilityTrusted, button: "Allow Accessibility Access") {
                permissions.requestAccessibility()
            }
            if !permissions.accessibilityTrusted {
                Text("In System Settings, turn on TabMail under Privacy & Security › Accessibility.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var screenReadingPage: some View {
        stepPage(
            title: "Features",
            systemImage: "switch.2",
            text: "Choose what TabMail may use. You can change this any time in Settings."
        ) {
            Toggle(isOn: $settings.readsScreen) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Read the screen while dictating")
                    Text("When you start dictating, TabMail reads the text in the window in front and sends it with your dictation, so names and terms are spelled as they appear there.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            if settings.readsScreen, !permissions.accessibilityTrusted {
                Text("Screen reading needs Accessibility access.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func stepPage(title: String, systemImage: String, text: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(title, systemImage: systemImage).font(.title2.bold())
            Text(text).fixedSize(horizontal: false, vertical: true)
            content()
        }
    }

    @ViewBuilder
    private func grantRow(granted: Bool, button: String, request: @escaping () -> Void) -> some View {
        if granted {
            Label("Allowed", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        } else {
            Button(button, action: request)
        }
    }
}

/// Category labels with one bubble per step beneath, as in the Thunderbird welcome wizard: the
/// current category and step are highlighted, passed steps are marked done and can be revisited.
private struct WelcomeRail: View {
    let wizard: WelcomeWizard

    var body: some View {
        HStack(alignment: .top, spacing: DictationConfig.welcomeRailCategorySpacing) {
            ForEach(WelcomeWizard.categories.indices, id: \.self) { categoryIndex in
                let category = WelcomeWizard.categories[categoryIndex]
                VStack(spacing: 8) {
                    Text(category.label.uppercased())
                        .font(.caption.weight(.medium))
                        .tracking(0.5)
                        .foregroundStyle(categoryIndex == wizard.categoryIndex ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary.opacity(DictationConfig.welcomeRailInactiveOpacity)))
                    HStack(spacing: DictationConfig.welcomeRailBubbleSpacing) {
                        ForEach(category.steps, id: \.self) { step in
                            bubble(for: WelcomeWizard.steps.firstIndex(of: step) ?? 0)
                        }
                    }
                }
            }
        }
    }

    private func bubble(for index: Int) -> some View {
        Circle()
            .fill(fill(for: index))
            .frame(width: DictationConfig.welcomeRailBubbleSize, height: DictationConfig.welcomeRailBubbleSize)
            .scaleEffect(index == wizard.index ? DictationConfig.welcomeRailActiveBubbleScale : 1)
            .contentShape(Rectangle())
            .onTapGesture { wizard.goTo(index) }
            .accessibilityElement()
            .accessibilityLabel("Step \(index + 1) of \(WelcomeWizard.steps.count)")
            .accessibilityAddTraits(index < wizard.index ? .isButton : [])
    }

    private func fill(for index: Int) -> AnyShapeStyle {
        if index == wizard.index { return AnyShapeStyle(.tint) }
        if index < wizard.index { return AnyShapeStyle(.green) }
        return AnyShapeStyle(Color(nsColor: .separatorColor))
    }
}
