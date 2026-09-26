// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Observation
import ServiceManagement

/// User preferences, persisted in UserDefaults.
@MainActor
@Observable
final class AppSettings {
    private enum Key {
        static let hotkey = "dictationHotkey"
        static let useDevelopmentServer = "useDevelopmentServer"
        static let readsScreen = "readsScreen"
        static let hasConsented = "hasConsentedToDictationData"
        static let hasFinishedWelcome = "hasFinishedWelcome"
        static let emailClient = "emailClient"
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored var onHotkeyChange: ((DictationHotkey) -> Void)?

    var hotkey: DictationHotkey {
        didSet {
            defaults.set(hotkey.rawValue, forKey: Key.hotkey)
            onHotkeyChange?(hotkey)
        }
    }

    /// Send dictation to dev.tabmail.ai (the development server) instead of api.tabmail.ai.
    var useDevelopmentServer: Bool {
        didSet { defaults.set(useDevelopmentServer, forKey: Key.useDevelopmentServer) }
    }

    /// Read the text of the window in front when a dictation starts and send it with the
    /// transcript for the cleanup (ADR-DESK-008). On unless the user switches it off.
    var readsScreen: Bool {
        didSet { defaults.set(readsScreen, forKey: Key.readsScreen) }
    }

    /// The user agreed, in the welcome wizard, to what dictation sends. No dictation without it.
    var hasConsented: Bool {
        didSet { defaults.set(hasConsented, forKey: Key.hasConsented) }
    }

    /// The welcome wizard was finished; until then it opens at every launch.
    var hasFinishedWelcome: Bool {
        didSet { defaults.set(hasFinishedWelcome, forKey: Key.hasFinishedWelcome) }
    }

    /// The bundle identifier of the email app that mail and calendar requests go to; nil for the
    /// user's default email app (`EmailClient`).
    var emailClient: String? {
        didSet { defaults.set(emailClient, forKey: Key.emailClient) }
    }

    var backendURL: URL {
        useDevelopmentServer ? DictationConfig.developmentBackendURL : DictationConfig.productionBackendURL
    }

    /// What a dictation uses, read once as it starts (`DictationSettings`).
    var dictation: DictationSettings {
        DictationSettings(
            hasConsented: hasConsented,
            backendURL: backendURL,
            readsScreen: readsScreen,
            emailApp: EmailClient.resolve(chosen: emailClient, systemDefault: EmailClient.systemDefault()?.bundleIdentifier)
        )
    }

    /// Mirrors the system's login-item registration rather than storing a copy of it.
    private(set) var launchAtLogin: Bool

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hotkey = defaults.string(forKey: Key.hotkey).flatMap(DictationHotkey.init(rawValue:)) ?? .rightOption
        useDevelopmentServer = defaults.bool(forKey: Key.useDevelopmentServer)
        readsScreen = defaults.object(forKey: Key.readsScreen) as? Bool ?? true
        hasConsented = defaults.bool(forKey: Key.hasConsented)
        hasFinishedWelcome = defaults.bool(forKey: Key.hasFinishedWelcome)
        emailClient = defaults.string(forKey: Key.emailClient)
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            Log.error("AppSettings: login item update failed: \(type(of: error))")
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }
}

/// The settings one dictation uses, read as the first thing it does when it starts and fixed for the
/// rest of it: a change in Settings meanwhile applies from the next dictation (owner, 2026-09-26).
struct DictationSettings: Equatable, Sendable {
    var hasConsented: Bool
    var backendURL: URL
    var readsScreen: Bool
    /// The email app mail and calendar requests go to (`EmailClient`); nil when there is none.
    var emailApp: String?
}
