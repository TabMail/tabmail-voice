// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit

/// The email app that mail and calendar requests go to: the one chosen in Settings, or else the
/// user's default email app when it is one TabMail's add-on runs in (a Thunderbird).
enum EmailClient {
    struct App: Equatable {
        let bundleIdentifier: String
        let name: String
    }

    /// The bundle identifier of the app to drive: `chosen` if set, else `systemDefault` if it is
    /// supported; nil when there is none, which leaves the tool out.
    static func resolve(chosen: String?, systemDefault: String?) -> String? {
        if let chosen { return chosen }
        guard let systemDefault, DictationConfig.thunderbirdBundleIdentifiers.contains(systemDefault) else { return nil }
        return systemDefault
    }

    /// The app the system opens `mailto:` links with.
    @MainActor
    static func systemDefault() -> App? {
        NSWorkspace.shared.urlForApplication(toOpen: DictationConfig.mailtoURL).flatMap(app(at:))
    }

    /// The supported email apps installed on this Mac, for Settings.
    @MainActor
    static func installed() -> [App] {
        DictationConfig.thunderbirdBundleIdentifiers.compactMap { id in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).flatMap(app(at:))
        }
    }

    private static func app(at url: URL) -> App? {
        guard let id = Bundle(url: url)?.bundleIdentifier else { return nil }
        return App(bundleIdentifier: id, name: FileManager.default.displayName(atPath: url.path))
    }
}
