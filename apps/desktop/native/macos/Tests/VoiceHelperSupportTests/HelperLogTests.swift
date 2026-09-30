// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import VoiceHelperSupport

/// The helpers' diagnostics reach the app's log as stderr lines.
struct HelperLogTests {
    /// A debug line is written in every build, with nothing in the environment to turn it on: the
    /// app decides whether to keep it, since a release build logs while debug mode is on.
    @Test func aDebugLineIsWrittenWithoutASwitch() throws {
        #expect(ProcessInfo.processInfo.environment["TABMAIL_VOICE_DEBUG"] == nil)
        let pipe = Pipe()
        let saved = dup(STDERR_FILENO)
        dup2(pipe.fileHandleForWriting.fileDescriptor, STDERR_FILENO)
        let marker = UUID().uuidString
        HelperLog.debug("probe \(marker)")
        dup2(saved, STDERR_FILENO)
        close(saved)
        try pipe.fileHandleForWriting.close()

        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(output.split(separator: "\n").contains("debug probe \(marker)"))
    }
}
