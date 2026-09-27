// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

@MainActor
struct DebugModeTests {
    private let defaults = InMemoryDefaults()
    /// No Thunderbird: these tests read only the server, never this Mac's Thunderbird profiles.
    private let noThunderbird = FileManager.default.temporaryDirectory.appending(path: "TabMailVoiceTests-\(UUID().uuidString)")

    /// Accounts on the TabMail domain, in any case, are allowed; lookalike domains, subdomains,
    /// other domains and no account are not.
    @Test(arguments: [
        ("tester@tabmail.ai", true),
        ("Tester@TabMail.AI", true),
        ("tester@nottabmail.ai", false),
        ("tester@mail.tabmail.ai", false),
        ("tester@tabmail.ai.example.com", false),
        ("tester@example.com", false),
        ("tabmail.ai", false),
        ("", false),
    ])
    func onlyAllowedAccountsMayUseDebugMode(email: String, allowed: Bool) {
        #expect(DebugAccess.allows(email) == allowed)
    }

    /// The named account outside the domain (TabMail's own, as on iOS) is allowed, in any case, and
    /// gets the development server; another account on its mail domain is not.
    @Test func theNamedAccountMayUseDebugMode() {
        let settings = AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird)
        settings.debugMode = true

        for email in ["tabmail.ai@gmail.com", "TABMAIL.AI@GMAIL.COM"] {
            #expect(DebugAccess.allows(email))
            #expect(settings.dictation(for: email).backendURL == DictationConfig.developmentBackendURL)
        }
        #expect(!DebugAccess.allows("someone@gmail.com"))
        #expect(settings.dictation(for: "someone@gmail.com").backendURL == DictationConfig.productionBackendURL)
    }

    @Test func noAccountMayUseDebugMode() {
        #expect(!DebugAccess.allows(nil))
    }

    /// Debug mode, and with it the development server, is on only when the switch is on AND the
    /// account signed in is allowed: a switch left on does nothing for another account or signed out.
    @Test(arguments: [
        (true, "tester@tabmail.ai", true),
        (false, "tester@tabmail.ai", false),
        (true, "tester@example.com", false),
        (true, nil, false),
    ] as [(Bool, String?, Bool)])
    func debugModeNeedsTheSwitchAndAnAllowedAccount(switchOn: Bool, email: String?, isOn: Bool) {
        let settings = AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird)
        settings.debugMode = switchOn

        #expect(settings.isDebugMode(for: email) == isOn)
        #expect(settings.dictation(for: email).backendURL == (isOn ? DictationConfig.developmentBackendURL : DictationConfig.productionBackendURL))
    }

    /// The switch is kept across launches, on and then off again, and starts off.
    @Test func theSwitchIsStoredAndStartsOff() {
        #expect(!AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird).debugMode)

        AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird).debugMode = true
        #expect(AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird).isDebugMode(for: "tester@tabmail.ai"))

        AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird).debugMode = false
        let relaunched = AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird)
        #expect(!relaunched.isDebugMode(for: "tester@tabmail.ai"))
        #expect(relaunched.dictation(for: "tester@tabmail.ai").backendURL == DictationConfig.productionBackendURL)
    }

    /// The old "Use development server" switch left on doesn't turn debug mode on (ADR-DESK-018).
    @Test func theOldDevelopmentServerSwitchIsNotCarriedOver() {
        defaults.set(true, forKey: "useDevelopmentServer")
        let settings = AppSettings(defaults: defaults, thunderbirdDirectory: noThunderbird)

        #expect(!settings.isDebugMode(for: "tester@tabmail.ai"))
        #expect(settings.dictation(for: "tester@tabmail.ai").backendURL == DictationConfig.productionBackendURL)
    }

    /// The menu's Start Dictation shows only in debug mode; a Stop for a recording in progress
    /// shows whatever the mode, so it can always be stopped.
    @Test(arguments: [
        (true, DictationController.Phase.idle, true),
        (false, .idle, false),
        (false, .arming, false),
        (false, .transcribing, false),
        (false, .failed("x"), false),
        (false, .listening, true),
        (true, .listening, true),
    ])
    func menuShowsDictationButtonOnlyInDebugModeOrWhileRecording(debugMode: Bool, phase: DictationController.Phase, shows: Bool) {
        #expect(MenuContent.showsDictationButton(debugMode: debugMode, phase: phase) == shows)
    }
}
