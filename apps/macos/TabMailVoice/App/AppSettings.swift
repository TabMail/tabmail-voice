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
        static let debugMode = "debugMode"
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

    /// The debug-mode switch as stored. Only `isDebugMode(for:)` says whether debug mode is on.
    var debugMode: Bool {
        didSet { defaults.set(debugMode, forKey: Key.debugMode) }
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

    /// Debug mode: dictation goes to dev.tabmail.ai (the development server) instead of
    /// api.tabmail.ai, and the menu shows its debug items. On only while the account signed in
    /// (`email`) is one `DebugAccess` allows, so a switch left on by an allowed account does
    /// nothing for any other.
    func isDebugMode(for email: String?) -> Bool {
        debugMode && DebugAccess.allows(email)
    }

    func backendURL(for email: String?) -> URL {
        isDebugMode(for: email) ? DictationConfig.developmentBackendURL : DictationConfig.productionBackendURL
    }

    /// What a dictation by the account signed in (`email`) uses, read once as it starts
    /// (`DictationSettings`).
    func dictation(for email: String?) -> DictationSettings {
        DictationSettings(
            hasConsented: hasConsented,
            hotkey: hotkey,
            backendURL: backendURL(for: email),
            readsScreen: readsScreen,
            emailApp: EmailClient.resolve(
                chosen: emailClient,
                systemDefault: EmailClient.systemDefault()?.bundleIdentifier,
                hasTabMail: EmailClient.hasTabMail(in: thunderbirdDirectory)
            )
        )
    }

    /// Where Thunderbird keeps its profiles, asked whether TabMail's add-on is installed.
    let thunderbirdDirectory: URL

    /// Mirrors the system's login-item registration rather than storing a copy of it.
    private(set) var launchAtLogin: Bool

    init(defaults: UserDefaults = .standard, thunderbirdDirectory: URL = DictationConfig.thunderbirdDataDirectory) {
        self.defaults = defaults
        self.thunderbirdDirectory = thunderbirdDirectory
        hotkey = defaults.string(forKey: Key.hotkey).flatMap(DictationHotkey.init(rawValue:)) ?? .rightOption
        debugMode = defaults.bool(forKey: Key.debugMode)
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
    /// The key held to dictate, which the double-tap tip names.
    var hotkey: DictationHotkey
    var backendURL: URL
    var readsScreen: Bool
    /// The email app mail and calendar requests go to (`EmailClient`); nil when there is none.
    var emailApp: String?
}
