// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// The helpers' diagnostics, one line each to stderr, which the app copies into its own log (its
/// debug log file while it keeps one, and errors to its production log). The app decides whether a
/// `debug` line is kept, since debug mode can be switched while the helper runs. Lengths, states and
/// error types only: never user content, which the app logs itself (ADR-DESK-015).
public enum HelperLog {
    public static func debug(_ message: @autoclosure () -> String) {
        write("debug", message())
    }

    /// Structured errors production observability needs. Must never carry user content.
    public static func error(_ message: @autoclosure () -> String) {
        write("error", message())
    }

    private static func write(_ level: String, _ message: String) {
        FileHandle.standardError.write(Data("\(level) \(message.replacingOccurrences(of: "\n", with: " "))\n".utf8))
    }
}
