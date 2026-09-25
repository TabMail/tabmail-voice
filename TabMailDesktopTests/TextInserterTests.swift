// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Testing
@testable import TabMail

/// Uses a private, uniquely named pasteboard and a stub keystroke, so tests never touch the
/// user's clipboard or type into another app.
@MainActor
struct TextInserterTests {
    private let pasteboard = NSPasteboard(name: NSPasteboard.Name("ai.tabmail.desktop.tests.\(UUID().uuidString)"))
    private let customType = NSPasteboard.PasteboardType("ai.tabmail.test.custom")

    private func inserter(onPaste: @escaping @MainActor () -> Void = {}) -> TextInserter {
        TextInserter(pasteboard: pasteboard, restoreDelay: .zero, pasteKeystroke: { onPaste() })
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

    @Test func restoresEveryItemAndTypeOfTheUsersClipboard() async {
        pasteboard.clearContents()
        let first = NSPasteboardItem()
        first.setString("user text", forType: .string)
        first.setData(Data([1, 2, 3]), forType: customType)
        let second = NSPasteboardItem()
        second.setString("second item", forType: .string)
        pasteboard.writeObjects([first, second])

        await inserter().insert("Dictated text")

        let items = pasteboard.pasteboardItems ?? []
        #expect(items.count == 2)
        guard items.count == 2 else { return }
        #expect(items[0].string(forType: .string) == "user text")
        #expect(items[0].data(forType: customType) == Data([1, 2, 3]))
        #expect(items[1].string(forType: .string) == "second item")
    }

    @Test func emptyClipboardStaysEmpty() async {
        pasteboard.clearContents()
        await inserter().insert("Dictated text")
        #expect(pasteboard.pasteboardItems?.isEmpty ?? true)
    }

    /// If the user copies something while the paste is in flight, their new copy wins.
    @Test func doesNotClobberAClipboardChangedDuringInsertion() async {
        pasteboard.clearContents()
        pasteboard.setString("old clipboard", forType: .string)
        let pasteboard = self.pasteboard
        await inserter {
            pasteboard.clearContents()
            pasteboard.setString("copied meanwhile", forType: .string)
        }.insert("Dictated text")
        #expect(pasteboard.string(forType: .string) == "copied meanwhile")
    }
}
