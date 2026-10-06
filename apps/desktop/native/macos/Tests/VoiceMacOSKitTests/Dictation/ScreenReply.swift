// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
