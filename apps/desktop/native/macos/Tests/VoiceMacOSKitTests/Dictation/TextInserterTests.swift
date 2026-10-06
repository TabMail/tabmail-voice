// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Testing
@testable import VoiceMacOSKit

/// Uses a private, uniquely named pasteboard and a stub keystroke, so tests never touch the
/// user's clipboard or type into another app.
@MainActor
struct TextInserterTests {
    private let pasteboard = NSPasteboard(name: NSPasteboard.Name("ai.tabmail.voice.tests.\(UUID().uuidString)"))
    private let customType = NSPasteboard.PasteboardType("ai.tabmail.test.custom")

    private func inserter(onPaste: @escaping @MainActor () -> Void = {}) -> TextInserter {
        TextInserter(pasteboard: pasteboard, pasteKeystroke: { onPaste() })
    }

    @Test func pastesTheTextMarkedTransient() async {
        var seenAtPaste: String?
        var typesAtPaste: [NSPasteboard.PasteboardType] = []
        let pasteboard = self.pasteboard
        await inserter {
            seenAtPaste = pasteboard.string(forType: .string)
            typesAtPaste = pasteboard.types ?? []
        }.insert("Dictated text")
        #expect(seenAtPaste == "Dictated text")
        #expect(typesAtPaste.contains(TextInserter.transientType))
        #expect(typesAtPaste.contains(TextInserter.concealedType))
    }

    /// The user's clipboard is replaced, never read: an app that hands its clipboard over late
    /// can't hold the paste up, and nothing of the user's is copied.
    @Test func neverReadsTheUsersClipboard() async {
        let provider = LateProvider()
        let item = NSPasteboardItem()
        item.setDataProvider(provider, forTypes: [.string, customType])
        pasteboard.clearContents()
        pasteboard.writeObjects([item])

        await inserter().insert("Dictated text")

        #expect(provider.asked == 0)
    }

    /// The paste's steps are timed in the debug log (stderr, which the app keeps in debug mode), with
    /// nothing of the text. No other test in this target redirects stderr; each target runs alone.
    @Test func timesThePasteStepsWithoutTheText() async throws {
        let marker = "Dictated \(UUID().uuidString)"
        let pipe = Pipe()
        let saved = dup(STDERR_FILENO)
        dup2(pipe.fileHandleForWriting.fileDescriptor, STDERR_FILENO)
        await inserter().insert(marker)
        dup2(saved, STDERR_FILENO)
        close(saved)
        try pipe.fileHandleForWriting.close()

        let lines = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        let steps = ["clipboard written", "paste keystroke sent"].map { step in
            lines.firstIndex { $0.wholeMatch(of: try! Regex("debug TextInserter: \(step) after \\d+ms")) != nil }
        }
        #expect(steps.allSatisfy { $0 != nil })
        #expect(steps.compactMap { $0 } == steps.compactMap { $0 }.sorted())
        #expect(!lines.contains { $0.contains(marker) })
    }

    @Test func theTextStaysOnTheClipboard() async {
        pasteboard.clearContents()
        pasteboard.setString("user text", forType: .string)
        await inserter().insert("Dictated text")
        #expect(pasteboard.pasteboardItems?.count == 1)
        #expect(pasteboard.string(forType: .string) == "Dictated text")
    }
}

/// Clipboard data an app hands over only when asked, counting the asks.
private final class LateProvider: NSObject, NSPasteboardItemDataProvider {
    var asked = 0

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        asked += 1
        item.setString("user text", forType: type)
    }
}
