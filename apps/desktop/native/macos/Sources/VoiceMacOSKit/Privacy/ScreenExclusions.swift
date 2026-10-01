// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import VoiceHelperSupport

/// What the user excludes from screen reading (ADR-DESK-045, ADR-DESK-047): apps, by identifier, and
/// websites, by host. Every request that reads another app carries both lists, and nothing excluded
/// is read. The host cases every platform's helper shares are in
/// `native/shared/privacy/host-exclusion-cases.json`.
struct ScreenExclusions: Sendable, Equatable {
    var appIDs: [String]
    var hosts: [String]

    init(appIDs: [String] = [], hosts: [String] = []) {
        self.appIDs = appIDs
        self.hosts = hosts
    }

    /// The lists as the request carries them. A request without either is refused, so nothing is
    /// read by mistake.
    init(params: JSON, method: String) throws {
        appIDs = try Self.strings(params, "excludedAppIDs", method)
        hosts = try Self.strings(params, "excludedHosts", method)
    }

    private static func strings(_ params: JSON, _ name: String, _ method: String) throws -> [String] {
        guard let values = params[name]?.array else { throw HelperError("\(method) needs \(name)") }
        let strings = values.compactMap(\.string)
        guard strings.count == values.count else { throw HelperError("\(method) needs \(name) as strings") }
        return strings
    }

    /// Whether the app is excluded. Identifiers are compared whole and without regard to case, as
    /// macOS does; an app without one can't be excluded.
    func excludesApp(_ identifier: String?) -> Bool {
        guard let id = identifier?.lowercased() else { return false }
        return appIDs.contains { $0.lowercased() == id }
    }

    /// Whether a page on `host` is excluded: an excluded host itself, or a subdomain of one, without
    /// regard to case or to a trailing dot. A page without a host can't be excluded.
    func excludesHost(_ host: String?) -> Bool {
        guard let name = host.map(Self.normalized), !name.isEmpty else { return false }
        return hosts.contains { excluded in
            let site = Self.normalized(excluded)
            return !site.isEmpty && (name == site || name.hasSuffix("." + site))
        }
    }

    /// Whether a page is excluded: one on an excluded host, and one whose address the app did not
    /// give when asked. What can't be told safe is not read.
    func excludes(_ page: PageHost) -> Bool {
        switch page {
        case .unknown: true
        case .noHost: false
        case let .host(name): excludesHost(name)
        }
    }

    private static func normalized(_ host: String) -> String {
        let name = host.lowercased()
        return name.hasSuffix(".") ? String(name.dropLast()) : name
    }
}

/// What a web area says of its page's address: its host (for a page that is not a web page, its
/// scheme), no host when the page has no address, or unknown when the app failed to answer.
enum PageHost: Sendable, Equatable {
    case host(String), noHost, unknown

    var name: String? {
        if case let .host(name) = self { name } else { nil }
    }
}
