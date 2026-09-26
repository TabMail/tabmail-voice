// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

/// The debug log file, written in a scratch folder: lines are appended in order, and a file past
/// its size limit is moved aside (replacing the earlier one) before the next line starts a new file.
struct LogFileTests {
    private let folder = FileManager.default.temporaryDirectory.appendingPathComponent("LogFileTests-\(UUID().uuidString)")
    private var url: URL { folder.appendingPathComponent("Logs/Test.log") }

    private func read(_ url: URL) -> String? { try? String(contentsOf: url, encoding: .utf8) }

    @Test func appendsLinesInOrderCreatingTheFolder() {
        defer { try? FileManager.default.removeItem(at: folder) }
        LogFile.write("one\n", to: url, maxBytes: 1_000)
        LogFile.write("two\n", to: url, maxBytes: 1_000)
        #expect(read(url) == "one\ntwo\n")
    }

    @Test func aFullFileIsMovedAsideAndANewOneStarted() {
        defer { try? FileManager.default.removeItem(at: folder) }
        let previous = LogFile.previousURL(of: url)
        #expect(previous.lastPathComponent == "Test.1.log")

        LogFile.write("0123456789\n", to: url, maxBytes: 10)
        LogFile.write("second\n", to: url, maxBytes: 10)
        #expect(read(previous) == "0123456789\n")
        #expect(read(url) == "second\n")

        // Within the limit nothing moves; past it again, the earlier file is replaced.
        LogFile.write("third\n", to: url, maxBytes: 10)
        #expect(read(url) == "second\nthird\n")
        LogFile.write("fourth\n", to: url, maxBytes: 10)
        #expect(read(previous) == "second\nthird\n")
        #expect(read(url) == "fourth\n")
    }
}
