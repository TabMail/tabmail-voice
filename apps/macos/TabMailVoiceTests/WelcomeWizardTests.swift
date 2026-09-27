// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

@MainActor
struct WelcomeWizardTests {
    private let defaults = InMemoryDefaults()

    /// Consent, then the two permissions, then the features, under three rail categories; Back
    /// walks them in reverse.
    @Test func stepsRunConsentThenPermissionsThenFeatures() {
        #expect(WelcomeWizard.categories.map(\.label) == ["Consent", "Permissions", "Features"])
        #expect(WelcomeWizard.steps == [.consent, .microphone, .accessibility, .screenReading])

        let settings = AppSettings(defaults: defaults)
        settings.hasConsented = true
        let wizard = WelcomeWizard(settings: settings)
        var categories = [wizard.categoryIndex]
        while !wizard.isLastStep {
            wizard.next()
            categories.append(wizard.categoryIndex)
        }
        #expect(categories == [0, 1, 1, 2])

        // Back retraces the same steps one at a time.
        var steps: [WelcomeWizard.Step] = []
        while !wizard.isFirstStep {
            wizard.back()
            steps.append(wizard.step)
        }
        #expect(steps == [.accessibility, .microphone, .consent])
    }

    /// No step after consent is reachable until the user agrees; withdrawing it blocks again.
    @Test func consentComesBeforeEverythingElse() {
        let settings = AppSettings(defaults: defaults)
        let wizard = WelcomeWizard(settings: settings)

        #expect(!wizard.canAdvance)
        wizard.next()
        wizard.goTo(1)
        #expect(wizard.step == .consent)

        settings.hasConsented = true
        #expect(wizard.canAdvance)
        wizard.next()
        #expect(wizard.step == .microphone)

        wizard.back()
        settings.hasConsented = false
        wizard.next()
        #expect(wizard.step == .consent)
    }

    /// Permissions and features never block Next: they can be granted or changed later.
    @Test func permissionAndFeatureStepsCanBeSkipped() {
        let settings = AppSettings(defaults: defaults)
        settings.hasConsented = true
        let wizard = WelcomeWizard(settings: settings)
        wizard.next()
        for step in [WelcomeWizard.Step.microphone, .accessibility, .screenReading] {
            #expect(wizard.step == step)
            #expect(wizard.canAdvance)
            if step != .screenReading { wizard.next() }
        }
    }

    /// Like the Thunderbird rail: a bubble goes back to a step already reached, never ahead.
    @Test func railBubblesOnlyGoBack() {
        let settings = AppSettings(defaults: defaults)
        settings.hasConsented = true
        let wizard = WelcomeWizard(settings: settings)
        wizard.next()
        wizard.next()
        #expect(wizard.index == 2)

        wizard.goTo(3)
        #expect(wizard.index == 2)
        wizard.goTo(-1)
        #expect(wizard.index == 2)
        wizard.goTo(2)
        #expect(wizard.index == 2)
        wizard.goTo(0)
        #expect(wizard.index == 0)
        #expect(wizard.isFirstStep)
        wizard.back()
        #expect(wizard.index == 0)
    }

    /// Finish is on the last step only; it records the wizard as done (so it stops opening at
    /// launch) and closes it, once.
    @Test func finishingRecordsTheWizardAsDone() {
        let settings = AppSettings(defaults: defaults)
        settings.hasConsented = true
        let wizard = WelcomeWizard(settings: settings)
        var finishes = 0
        wizard.onFinish = { finishes += 1 }

        while !wizard.isLastStep {
            wizard.next()
            #expect(!settings.hasFinishedWelcome)
            #expect(finishes == 0)
        }
        wizard.next()
        #expect(settings.hasFinishedWelcome)
        #expect(finishes == 1)
        #expect(wizard.step == .screenReading)
        #expect(AppSettings(defaults: defaults).hasFinishedWelcome)
    }
}

@MainActor
struct AppSettingsTests {
    private let defaults = InMemoryDefaults()

    /// A fresh install: screen reading on (it is disclosed in the consent step), no consent, the
    /// wizard not yet finished.
    @Test func freshInstallDefaults() {
        let settings = AppSettings(defaults: defaults)
        #expect(settings.readsScreen)
        #expect(!settings.hasConsented)
        #expect(!settings.hasFinishedWelcome)
    }

    /// Each choice survives a relaunch on its own, including screen reading switched off: no
    /// setting is stored under another's key.
    @Test(arguments: [(false, true, false), (true, false, true), (false, false, true), (true, true, false)])
    func choicesArePersisted(readsScreen: Bool, hasConsented: Bool, hasFinishedWelcome: Bool) {
        let settings = AppSettings(defaults: defaults)
        settings.readsScreen = readsScreen
        settings.hasConsented = hasConsented
        settings.hasFinishedWelcome = hasFinishedWelcome

        let relaunched = AppSettings(defaults: defaults)
        #expect(relaunched.readsScreen == readsScreen)
        #expect(relaunched.hasConsented == hasConsented)
        #expect(relaunched.hasFinishedWelcome == hasFinishedWelcome)
    }

    /// What a dictation takes at key-down is what Settings says: consent, screen reading (off means
    /// no screen read), the server (debug mode, for an account allowed it), and the email app chosen,
    /// which it only gets while a Thunderbird profile has TabMail's add-on.
    @Test(arguments: [(false, true, false, true), (true, false, true, true), (false, true, false, false)])
    func aDictationTakesWhatSettingsSay(readsScreen: Bool, hasConsented: Bool, debugMode: Bool, hasTabMail: Bool) throws {
        let thunderbird = try Fixtures.thunderbirdFolder(profiles: [[Fixtures.addon(userDisabled: !hasTabMail)]])
        defer { try? FileManager.default.removeItem(at: thunderbird) }
        let settings = AppSettings(defaults: defaults, thunderbirdDirectory: thunderbird)
        settings.readsScreen = readsScreen
        settings.hasConsented = hasConsented
        settings.debugMode = debugMode
        settings.emailClient = "org.example.mail"
        settings.hotkey = .function

        #expect(settings.dictation(for: "tester@tabmail.ai") == DictationSettings(
            hasConsented: hasConsented,
            hotkey: .function,
            backendURL: debugMode ? DictationConfig.developmentBackendURL : DictationConfig.productionBackendURL,
            readsScreen: readsScreen,
            emailApp: hasTabMail ? "org.example.mail" : nil
        ))
    }
}
