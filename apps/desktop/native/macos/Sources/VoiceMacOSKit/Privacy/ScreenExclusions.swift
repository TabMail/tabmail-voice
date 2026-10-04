// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import VoiceHelperSupport
import Foundation

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
        _ = try query([:])
    }

    private static func strings(_ params: JSON, _ name: String, _ method: String) throws -> [String] {
        guard let values = params[name]?.array else { throw HelperError("\(method) needs \(name)") }
        let strings = values.compactMap(\.string)
        guard strings.count == values.count else { throw HelperError("\(method) needs \(name) as strings") }
        return strings
    }

    /// Provider identity/URL acquisition stays native; comparisons share one policy.
    func excludesApp(_ identifier: String?) -> Bool {
        decision("app", identifier.map { $0 as Any } ?? NSNull())
    }

    func excludesHost(_ host: String?) -> Bool {
        decision("host", host.map { $0 as Any } ?? NSNull())
    }

    func excludes(_ page: PageHost) -> Bool {
        let kind: String
        switch page {
        case .unknown: kind = "unknown"
        case .noHost: kind = "noHost"
        case .host: kind = "host"
        }
        do {
            let result = try query(["page": kind, "host": page.name ?? ""])
            return result["page"] as? Bool ?? true
        } catch { return true }
    }

    private func decision(_ key: String, _ value: Any) -> Bool {
        do { return try query([key: value])[key] as? Bool ?? true }
        catch { return true } // A core failure can never allow a provider read.
    }

    private func query(_ fields: [String: Any]) throws -> [String: Any] {
        var input = fields
        input["excludedAppIDs"] = appIDs
        input["excludedHosts"] = hosts
        let data = try Redactor.request(JSONSerialization.data(withJSONObject: input), operation: .policy)
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Redactor.Failure.refused
        }
        return result
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
