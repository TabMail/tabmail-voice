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

    var backendURL: URL {
        useDevelopmentServer ? DictationConfig.developmentBackendURL : DictationConfig.productionBackendURL
    }

    /// Mirrors the system's login-item registration rather than storing a copy of it.
    private(set) var launchAtLogin: Bool

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hotkey = defaults.string(forKey: Key.hotkey).flatMap(DictationHotkey.init(rawValue:)) ?? .rightOption
        useDevelopmentServer = defaults.bool(forKey: Key.useDevelopmentServer)
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
