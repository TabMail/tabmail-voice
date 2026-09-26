// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

@MainActor
struct DebugModeTests {
    private let defaults = InMemoryDefaults()

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
        let settings = AppSettings(defaults: defaults)
        settings.debugMode = switchOn

        #expect(settings.isDebugMode(for: email) == isOn)
        #expect(settings.dictation(for: email).backendURL == (isOn ? DictationConfig.developmentBackendURL : DictationConfig.productionBackendURL))
    }

    /// The switch is kept across launches, and starts off.
    @Test func theSwitchIsStoredAndStartsOff() {
        #expect(!AppSettings(defaults: defaults).debugMode)

        AppSettings(defaults: defaults).debugMode = true
        #expect(AppSettings(defaults: defaults).debugMode)
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
