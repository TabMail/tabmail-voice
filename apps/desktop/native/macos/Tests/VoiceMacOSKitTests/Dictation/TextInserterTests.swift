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
        TextInserter(clipboard: ClipboardKeeper(pasteboard: pasteboard), pasteKeystroke: { onPaste() })
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
        #expect(typesAtPaste.contains(ClipboardKeeper.transientType))
        #expect(typesAtPaste.contains(ClipboardKeeper.concealedType))
    }

    /// The paste itself never reads the clipboard (`ClipboardKeeper.save` does, ahead of it): an app
    /// that hands its clipboard over late can't hold the paste up.
    @Test func thePasteNeverReadsTheClipboard() async {
        let provider = LateProvider()
        let item = NSPasteboardItem()
        item.setDataProvider(provider, forTypes: [.string, customType])
        pasteboard.clearContents()
        pasteboard.writeObjects([item])

        await inserter().insert("Dictated text")

        #expect(provider.asked == 0)
    }

    /// The paste's steps, the clipboard's save and its put-back included, are timed in the debug
    /// log (stderr, which the app keeps in debug mode), with nothing of the text or the clipboard. No
    /// other test in this target redirects stderr; each target runs alone. Their order is not
    /// checked: other tests in the target paste at the same time, and log the same steps.
    @Test func timesThePasteStepsWithoutTheText() async throws {
        let marker = "Dictated \(UUID().uuidString)"
        let copied = "Copied \(UUID().uuidString)"
        pasteboard.clearContents()
        pasteboard.setString(copied, forType: .string)
        let keeper = ClipboardKeeper(pasteboard: pasteboard, rules: .init(restoreDelay: 20, maxBytes: 1024, maxFormats: 8))
        let pipe = Pipe()
        let saved = dup(STDERR_FILENO)
        dup2(pipe.fileHandleForWriting.fileDescriptor, STDERR_FILENO)
        keeper.save()
        await keeper.saveTask?.value
        await TextInserter(clipboard: keeper, pasteKeystroke: {}).insert(marker)
        await keeper.restoreTask?.value
        dup2(saved, STDERR_FILENO)
        close(saved)
        try pipe.fileHandleForWriting.close()

        let lines = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        let steps = ["ClipboardKeeper: clipboard saved", "TextInserter: clipboard written", "TextInserter: paste keystroke sent", "ClipboardKeeper: clipboard put back"].map { step in
            lines.firstIndex { $0.wholeMatch(of: try! Regex("debug \(step) after \\d+ms")) != nil }
        }
        #expect(steps.allSatisfy { $0 != nil })
        #expect(!lines.contains { $0.contains(copied) })
        #expect(!lines.contains { $0.contains(marker) })
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
