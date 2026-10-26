// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// The parts of the reply the shared core builds (`ScreenContext.json`) that the tests check, for a
/// read with nothing excluded.
extension ScreenContext {
    var json: JSON { json(ScreenExclusions()) }

    func renderedText() throws -> String {
        guard let text = json["renderedText"]?.string else { throw Redactor.Failure.refused }
        return text
    }

    var summary: String { json["summary"]?.string ?? "" }

    var logDescription: String {
        get throws {
            guard let text = json["logDescription"]?.string else { throw Redactor.Failure.refused }
            return text
        }
    }
}

extension SharedContext {
    /// One of the shared core's limits (`{"limits": true}`), by name, so a test sizes its text from
    /// the core's numbers, not a copy of them.
    static func limit(_ name: String) throws -> Int {
        let input = try JSONSerialization.data(withJSONObject: ["limits": true])
        let limits = try JSONDecoder().decode(JSON.self, from: Redactor.request(input, operation: .context))
        guard let value = limits[name]?.integer else { throw Redactor.Failure.refused }
        return value
    }
}
