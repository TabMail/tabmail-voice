// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os

/// Debug-gated logging. Diagnostic logs are compiled out of Release builds; debug builds also keep
/// them in a file (`LogFile`).
///
/// Never log transcript text or audio: dictation is user content (ADR-004 spirit).
/// Log lengths, states and error types only.
enum Log {
    private static let logger = Logger(subsystem: "ai.tabmail.voice", category: "dictation")

    static func debug(_ message: @autoclosure () -> String) {
        #if DEBUG
        let text = message()
        logger.debug("\(text, privacy: .public)")
        LogFile.append("debug", text)
        #endif
    }

    /// Structured errors production observability needs. Must never carry user content.
    static func error(_ message: @autoclosure () -> String) {
        let text = message()
        logger.error("\(text, privacy: .public)")
        #if DEBUG
        LogFile.append("ERROR", text)
        #endif
    }
}

#if DEBUG
/// Debug builds keep their log in a file as well, so a session can be read after the fact: the
/// unified log keeps debug messages only in memory. The file is `~/Library/Logs/TabMail Voice/TabMail
/// Voice.log`; past `logFileMaxBytes` it becomes `TabMail Voice.1.log` and a new one starts. Nothing
/// is written while unit tests run.
enum LogFile {
    static let url = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/TabMail Voice/TabMail Voice.log")
    private static let queue = DispatchQueue(label: "ai.tabmail.voice.logfile")
    private static let isEnabled = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil

    static func append(_ level: String, _ text: String) {
        guard isEnabled else { return }
        let time = Date.now.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: .current))
        let line = "\(time) \(level) \(text)\n"
        queue.async { write(line, to: url, maxBytes: DictationConfig.logFileMaxBytes) }
    }

    /// Appends `line` to the file at `url`, first moving a file past `maxBytes` aside. Internal for tests.
    static func write(_ line: String, to url: URL, maxBytes: Int) {
        let files = FileManager.default
        try? files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = (try? files.attributesOfItem(atPath: url.path))?[.size] as? Int, size > maxBytes {
            let earlier = previousURL(of: url)
            try? files.removeItem(at: earlier)
            try? files.moveItem(at: url, to: earlier)
        }
        let data = Data(line.utf8)
        guard let handle = try? FileHandle(forWritingTo: url) else {
            try? data.write(to: url)
            return
        }
        defer { try? handle.close() }
        // Never write over the start of the file.
        guard (try? handle.seekToEnd()) != nil else { return }
        try? handle.write(contentsOf: data)
    }

    /// Where a full log file is moved: "TabMail Voice.log" → "TabMail Voice.1.log".
    static func previousURL(of url: URL) -> URL {
        url.deletingPathExtension().appendingPathExtension("1").appendingPathExtension(url.pathExtension)
    }
}
#endif
