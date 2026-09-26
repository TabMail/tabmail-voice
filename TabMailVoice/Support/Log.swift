// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os

/// Debug-gated logging. Diagnostic logs are compiled out of Release builds.
///
/// Never log transcript text or audio: dictation is user content (ADR-004 spirit).
/// Log lengths, states and error types only.
enum Log {
    private static let logger = Logger(subsystem: "ai.tabmail.voice", category: "dictation")

    static func debug(_ message: @autoclosure () -> String) {
        #if DEBUG
        let text = message()
        logger.debug("\(text, privacy: .public)")
        #endif
    }

    /// Structured errors production observability needs. Must never carry user content.
    static func error(_ message: @autoclosure () -> String) {
        let text = message()
        logger.error("\(text, privacy: .public)")
    }
}
