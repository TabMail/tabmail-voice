// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit

/// The email app that mail and calendar requests go to: the one chosen in Settings, or else the
/// user's default email app when it is one TabMail's add-on runs in (a Thunderbird); none while no
/// Thunderbird profile has the add-on.
enum EmailClient {
    struct App: Equatable {
        let bundleIdentifier: String
        let name: String
    }

    /// The bundle identifier of the app to drive: `chosen` if set, else `systemDefault` if it is
    /// supported; nil when there is none or TabMail's add-on isn't installed, which leaves the tool
    /// out.
    static func resolve(chosen: String?, systemDefault: String?, hasTabMail: Bool) -> String? {
        guard hasTabMail else { return nil }
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

    /// Whether a Thunderbird profile in `directory` has TabMail's add-on installed and enabled. Every
    /// profile in its `profiles.ini` counts: Thunderbird and Thunderbird Beta share the folder, and
    /// nothing there says which profile an installation opens.
    static func hasTabMail(in directory: URL) -> Bool {
        guard let ini = try? String(contentsOf: directory.appending(path: "profiles.ini"), encoding: .utf8) else { return false }
        let found = profiles(in: ini, directory: directory).contains { profile in
            guard let data = try? Data(contentsOf: profile.appending(path: "extensions.json")),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let addons = json["addons"] as? [[String: Any]] else { return false }
            return addons.contains {
                $0["id"] as? String == DictationConfig.tabMailAddonID
                    && $0["userDisabled"] as? Bool != true && $0["appDisabled"] as? Bool != true
            }
        }
        if !found { Log.debug("EmailClient: no Thunderbird profile has TabMail's add-on") }
        return found
    }

    /// The profile folders `profiles.ini` lists: the `Path=` of each section, relative to `directory`
    /// when the section says `IsRelative=1`.
    private static func profiles(in ini: String, directory: URL) -> [URL] {
        var profiles: [URL] = []
        var path: String?
        var isRelative = false
        func close() {
            if let path { profiles.append(isRelative ? directory.appending(path: path) : URL(fileURLWithPath: path)) }
            path = nil
            isRelative = false
        }
        for line in ini.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) }) {
            if line.hasPrefix("[") {
                close()
            } else if line.hasPrefix("Path=") {
                path = String(line.dropFirst("Path=".count))
            } else if line.hasPrefix("IsRelative=") {
                isRelative = line == "IsRelative=1"
            }
        }
        close()
        return profiles
    }

    private static func app(at url: URL) -> App? {
        guard let id = Bundle(url: url)?.bundleIdentifier else { return nil }
        return App(bundleIdentifier: id, name: FileManager.default.displayName(atPath: url.path))
    }
}
