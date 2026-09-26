// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMail

/// Settings in a UserDefaults suite of their own, removed when the test ends.
private final class ScratchDefaults {
    let name = "ai.tabmail.desktop.tests.\(UUID().uuidString)"
    let defaults: UserDefaults

    init() {
        defaults = UserDefaults(suiteName: name)!
    }

    deinit {
        UserDefaults().removePersistentDomain(forName: name)
    }
}

@MainActor
struct WelcomeWizardTests {
    private let scratch = ScratchDefaults()

    /// Consent, then the two permissions, then the features, under three rail categories.
    @Test func stepsRunConsentThenPermissionsThenFeatures() {
        #expect(WelcomeWizard.categories.map(\.label) == ["Consent", "Permissions", "Features"])
        #expect(WelcomeWizard.steps == [.consent, .microphone, .accessibility, .screenReading])

        let settings = AppSettings(defaults: scratch.defaults)
        settings.hasConsented = true
        let wizard = WelcomeWizard(settings: settings)
        var categories = [wizard.categoryIndex]
        while !wizard.isLastStep {
            wizard.next()
            categories.append(wizard.categoryIndex)
        }
        #expect(categories == [0, 1, 1, 2])
    }

    /// No step after consent is reachable until the user agrees; withdrawing it blocks again.
    @Test func consentComesBeforeEverythingElse() {
        let settings = AppSettings(defaults: scratch.defaults)
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
        let settings = AppSettings(defaults: scratch.defaults)
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
        let settings = AppSettings(defaults: scratch.defaults)
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
        let settings = AppSettings(defaults: scratch.defaults)
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
        #expect(AppSettings(defaults: scratch.defaults).hasFinishedWelcome)
    }
}

@MainActor
struct AppSettingsTests {
    private let scratch = ScratchDefaults()

    /// A fresh install: screen reading on (it is disclosed in the consent step), no consent, the
    /// wizard not yet finished.
    @Test func freshInstallDefaults() {
        let settings = AppSettings(defaults: scratch.defaults)
        #expect(settings.readsScreen)
        #expect(!settings.hasConsented)
        #expect(!settings.hasFinishedWelcome)
    }

    /// Each choice survives a relaunch, including screen reading switched off.
    @Test(arguments: [false, true])
    func choicesArePersisted(value: Bool) {
        let settings = AppSettings(defaults: scratch.defaults)
        settings.readsScreen = value
        settings.hasConsented = value
        settings.hasFinishedWelcome = value

        let relaunched = AppSettings(defaults: scratch.defaults)
        #expect(relaunched.readsScreen == value)
        #expect(relaunched.hasConsented == value)
        #expect(relaunched.hasFinishedWelcome == value)
    }
}
