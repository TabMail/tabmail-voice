// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import os
import Testing
@testable import VoiceMacOSKit

/// Uses a private, uniquely named pasteboard and a stub keystroke, so tests never touch the
/// user's clipboard or type into another app.
@MainActor
struct ClipboardKeeperTests {
    private let pasteboard = NSPasteboard(name: NSPasteboard.Name("ai.tabmail.voice.tests.\(UUID().uuidString)"))
    private let customType = NSPasteboard.PasteboardType("ai.tabmail.test.custom")
    private static let rules = SharedRequest.ClipboardRules(restoreDelay: 20, maxBytes: 1024, maxFormats: 8)

    private func keeper(read: @escaping ClipboardKeeper.Reader = ClipboardKeeper.readItems,
                        delay: ClipboardKeeper.Delay? = nil) -> ClipboardKeeper {
        guard let delay else { return ClipboardKeeper(pasteboard: pasteboard, rules: Self.rules, read: read) }
        return ClipboardKeeper(pasteboard: pasteboard, rules: Self.rules, read: read, delay: delay)
    }

    private func paste(_ text: String, with keeper: ClipboardKeeper, onPaste: @escaping @MainActor () -> Void = {}) async {
        await TextInserter(clipboard: keeper, pasteKeystroke: { onPaste() }).insert(text)
    }

    private func copy(_ text: String, custom: Data? = nil) {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        if let custom { item.setData(custom, forType: customType) }
        pasteboard.writeObjects([item])
    }

    /// The clipboard as it was, every type of it, goes back after the paste: the paste's text is on
    /// it as the keys are sent, and not after.
    @Test func putsTheClipboardBackAfterThePaste() async {
        copy("user text", custom: Data([1, 2, 3]))
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        var seenAtPaste: String?
        await paste("Dictated text", with: keeper) { seenAtPaste = self.pasteboard.string(forType: .string) }
        #expect(seenAtPaste == "Dictated text")
        // Not yet: the target app reads the clipboard as it handles the keys.
        #expect(pasteboard.string(forType: .string) == "Dictated text")
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "user text")
        #expect(pasteboard.data(forType: customType) == Data([1, 2, 3]))
        #expect(pasteboard.pasteboardItems?.count == 1)
    }

    /// An empty clipboard is empty again after the paste.
    @Test func putsAnEmptyClipboardBackEmpty() async {
        pasteboard.clearContents()
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.pasteboardItems?.isEmpty ?? true)
    }

    /// A clipboard that couldn't be read (macOS gives no items, not an empty list) is not saved: put
    /// back, it would be cleared, as though it had been empty. The paste's text stays.
    @Test func doesNotPutBackAClipboardThatCouldNotBeRead() async {
        copy("user text")
        let keeper = keeper(read: { pasteboard, rules in
            let original: AnyClass? = object_setClass(pasteboard, UnreadablePasteboard.self)
            defer { if let original { object_setClass(pasteboard, original) } }
            #expect(pasteboard.pasteboardItems == nil)
            return ClipboardKeeper.readItems(pasteboard, rules)
        })
        keeper.save()
        await keeper.saveTask?.value
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "Dictated text")
    }

    /// A clipboard whose app hands it over late never holds the paste up: the paste goes ahead while
    /// the save waits, and its text stays, the save having read a clipboard the paste replaced.
    @Test func thePasteNeverWaitsForTheSave() async {
        copy("user text")
        let gate = Gate()
        let keeper = keeper { pasteboard, rules in
            gate.wait()
            return ClipboardKeeper.readItems(pasteboard, rules)
        }
        keeper.save()
        let started = ContinuousClock.now
        await paste("Dictated text", with: keeper)
        #expect(started.duration(to: .now) < .seconds(1))
        gate.open()
        await keeper.saveTask?.value
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "Dictated text")
    }

    /// A copy made after the paste, before the clipboard goes back, is kept.
    @Test func keepsACopyMadeAfterThePaste() async {
        copy("user text")
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        await paste("Dictated text", with: keeper)
        copy("copied later")
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "copied later")
    }

    /// A copy made as the paste's text is written, before the keeper takes the clipboard's change
    /// count as its own, is never put back over.
    @Test func keepsACopyMadeAsThePasteIsWritten() async {
        copy("user text")
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        let original: AnyClass? = object_setClass(pasteboard, CopyingAfterWritePasteboard.self)
        defer { if let original { object_setClass(pasteboard, original) } }
        CopyingAfterWritePasteboard.copyNext.withLock { $0 = true }
        await paste("Dictated text", with: keeper)
        #expect(pasteboard.string(forType: .string) == "copied as written")
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "copied as written")
    }

    /// An app that reads the clipboard a while after the paste keys, within `restoreDelay`, gets the
    /// paste's text; the clipboard as it was goes back after.
    @Test func anAppReadingAfterTheKeysGetsThePastesText() async {
        copy("user text")
        let rules = SharedRequest.clipboardRules
        let keeper = ClipboardKeeper(pasteboard: pasteboard, rules: rules)
        keeper.save()
        await keeper.saveTask?.value
        let pasteboard = pasteboard
        var app: Task<String?, Never>?
        await paste("Dictated text", with: keeper) {
            app = Task {
                try? await Task.sleep(for: .milliseconds(rules.restoreDelay / 10))
                return pasteboard.string(forType: .string)
            }
        }
        #expect(await app?.value == "Dictated text")
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "user text")
    }

    /// The app asks again and again until the paste (ADR-DESK-002, amended 2026-10-09): a copy made
    /// after the first save, saved by a later ask, is what goes back, every type of it.
    @Test func putsTheNewestSavedClipboardBack() async {
        copy("user text", custom: Data([1, 2, 3]))
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        copy("copied while transcribed", custom: Data([7, 8, 9]))
        keeper.save()
        await keeper.saveTask?.value
        var seenAtPaste: String?
        await paste("Dictated text", with: keeper) { seenAtPaste = self.pasteboard.string(forType: .string) }
        #expect(seenAtPaste == "Dictated text")
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "copied while transcribed")
        #expect(pasteboard.data(forType: customType) == Data([7, 8, 9]))
    }

    /// A save older than a copy made before the paste is never put back over it.
    @Test func neverPutsBackASaveOlderThanTheClipboard() async {
        copy("user text")
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        copy("copied since")
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) != "user text")
    }

    /// A clipboard copied while it was being saved is not kept as saved.
    @Test func dropsASaveTheClipboardChangedDuring() async {
        copy("user text")
        let gate = Gate()
        let keeper = keeper { pasteboard, rules in
            gate.wait()
            return ClipboardKeeper.readItems(pasteboard, rules)
        }
        keeper.save()
        copy("copied meanwhile")
        gate.open()
        await keeper.saveTask?.value
        // Saved again as it is now; the paste then puts back the newer copy.
        keeper.save()
        await keeper.saveTask?.value
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "copied meanwhile")
    }

    /// Two pastes in a row, the second before the first's clipboard went back: the clipboard as it
    /// was before both goes back once.
    @Test func putsTheFirstClipboardBackAfterTwoPastes() async {
        copy("user text")
        let delays = HeldDelays()
        let keeper = keeper(delay: delays.wait)
        keeper.save()
        await keeper.saveTask?.value
        await paste("First", with: keeper)
        let first = keeper.restoreTask
        // The next dictation's save finds the paste's text over a clipboard already saved.
        keeper.save()
        await paste("Second", with: keeper)
        #expect(pasteboard.string(forType: .string) == "Second")
        // In either order: the first finds the clipboard changed since its paste; the second puts
        // back the clipboard as it was before both.
        delays.open(0)
        delays.open(1)
        await first?.value
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "user text")
    }

    /// A clipboard left as it was is read once for a dictation, not again for its second save; one
    /// put back is read again, as the change count after a put-back may be a newer copy's.
    @Test func readsAnUnchangedClipboardOnceAndAgainOncePutBack() async {
        copy("user text")
        let reads = OSAllocatedUnfairLock(initialState: 0)
        let keeper = keeper { pasteboard, rules in
            reads.withLock { $0 += 1 }
            return ClipboardKeeper.readItems(pasteboard, rules)
        }
        keeper.save()
        keeper.save()
        await keeper.saveTask?.value
        keeper.save()
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(reads.withLock { $0 } == 1)
        #expect(pasteboard.string(forType: .string) == "user text")
        keeper.save()
        await keeper.saveTask?.value
        #expect(reads.withLock { $0 } == 2)
    }

    /// An owner that never answers holds one read, however often the clipboard changes meanwhile:
    /// a save asked for while one is reading is skipped.
    @Test func runsOneReadAtATime() async {
        copy("user text")
        let gate = Gate()
        let reads = OSAllocatedUnfairLock(initialState: 0)
        let keeper = keeper { pasteboard, rules in
            reads.withLock { $0 += 1 }
            gate.wait()
            return ClipboardKeeper.readItems(pasteboard, rules)
        }
        keeper.save()
        for index in 0..<4 {
            copy("copy \(index)")
            keeper.save()
        }
        // The skipped saves started no task; this one is the first read's, held until opened.
        let held = keeper.saveTask
        try? await Task.sleep(for: .milliseconds(50))
        #expect(reads.withLock { $0 } == 1)
        gate.open()
        await held?.value
        // Once it is done, the clipboard as it is now is saved and goes back.
        keeper.save()
        await keeper.saveTask?.value
        #expect(reads.withLock { $0 } == 2)
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "copy 3")
    }

    /// Every item goes back, in its order.
    @Test func putsEveryItemBackInOrder() async {
        let original = ["first item", "second item"]
        pasteboard.clearContents()
        pasteboard.writeObjects(original.map { text in
            let item = NSPasteboardItem()
            item.setString(text, forType: .string)
            return item
        })
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.pasteboardItems?.compactMap { $0.string(forType: .string) } == original)
    }

    /// A target app slow to handle the paste keys still reads the paste's text: the clipboard goes
    /// back only after them.
    @Test func aSlowPasteStillReadsTheText() async {
        copy("user text")
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        var pasted: String?
        await TextInserter(clipboard: keeper, pasteKeystroke: {
            try? await Task.sleep(for: .milliseconds(Self.rules.restoreDelay * 5))
            pasted = self.pasteboard.string(forType: .string)
        }).insert("Dictated text")
        #expect(pasted == "Dictated text")
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "user text")
    }

    /// A password manager's clipboard (marked concealed) is not read, and not put back, where the
    /// manager would no longer clear it: the paste's text stays.
    @Test func neverReadsOrPutsBackAConcealedClipboard() async {
        let provider = LateProvider()
        let item = NSPasteboardItem()
        item.setDataProvider(provider, forTypes: [.string])
        item.setString("", forType: ClipboardKeeper.concealedType)
        pasteboard.clearContents()
        pasteboard.writeObjects([item])
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(provider.asked == 0)
        #expect(pasteboard.string(forType: .string) == "Dictated text")
    }

    /// A clipboard with more data or formats than the shared core allows is not saved.
    @Test func doesNotSaveAClipboardOverTheLimits() {
        copy("user text", custom: Data(count: Self.rules.maxBytes))
        #expect(ClipboardKeeper.readItems(pasteboard, Self.rules) == nil)
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        for index in 0...Self.rules.maxFormats { item.setString("\(index)", forType: .init("ai.tabmail.test.format\(index)")) }
        pasteboard.writeObjects([item])
        #expect(ClipboardKeeper.readItems(pasteboard, Self.rules) == nil)
        copy("user text")
        #expect(ClipboardKeeper.readItems(pasteboard, Self.rules)?.first?[.string] == Data("user text".utf8))
    }

    /// A clipboard right at the limits, in data or in formats, is saved and put back whole.
    @Test func putsBackAClipboardAtTheLimits() async {
        let custom = Data(count: Self.rules.maxBytes - "user text".utf8.count)
        let formats = (1..<Self.rules.maxFormats).map { NSPasteboard.PasteboardType("ai.tabmail.test.format\($0)") }
        for atFormatLimit in [false, true] {
            if atFormatLimit {
                pasteboard.clearContents()
                let item = NSPasteboardItem()
                item.setString("user text", forType: .string)
                for type in formats { item.setString("f", forType: type) }
                pasteboard.writeObjects([item])
            } else {
                copy("user text", custom: custom)
            }
            let keeper = keeper()
            keeper.save()
            await keeper.saveTask?.value
            await paste("Dictated text", with: keeper)
            await keeper.restoreTask?.value
            #expect(pasteboard.string(forType: .string) == "user text")
            if atFormatLimit {
                #expect(pasteboard.pasteboardItems?.first?.types.count == Self.rules.maxFormats)
            } else {
                #expect(pasteboard.data(forType: customType) == custom)
            }
        }
    }

    /// An item whose owner gives none of its data was not read: the clipboard is not saved, so not
    /// put back empty, and the paste's text stays.
    @Test func doesNotPutBackAnItemItsOwnerGaveNothingFor() async {
        let owner = GivesNothing()
        let item = NSPasteboardItem()
        item.setDataProvider(owner, forTypes: [.string])
        pasteboard.clearContents()
        pasteboard.writeObjects([item])
        let keeper = keeper()
        keeper.save()
        await keeper.saveTask?.value
        #expect(owner.asked.withLock { $0 } > 0)
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "Dictated text")
    }

    /// Without a save, the paste's text stays.
    @Test func leavesThePasteWithNoSave() async {
        copy("user text")
        let keeper = keeper()
        await paste("Dictated text", with: keeper)
        await keeper.restoreTask?.value
        #expect(pasteboard.string(forType: .string) == "Dictated text")
    }
}

/// Holds each put-back's delay, numbered in the order they were asked for, until the test opens it.
private final class HeldDelays: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: (asked: 0, open: Set<Int>()))
    func wait(_: Int) async {
        let call = state.withLock { state in
            defer { state.asked += 1 }
            return state.asked
        }
        while !state.withLock({ $0.open.contains(call) }) { try? await Task.sleep(for: .milliseconds(1)) }
    }
    func open(_ call: Int) { _ = state.withLock { $0.open.insert(call) } }
}

/// Holds reads until opened, on the save's own thread; once open, it stays open.
private final class Gate: Sendable {
    private let group: DispatchGroup = {
        let group = DispatchGroup()
        group.enter()
        return group
    }()
    func wait() { group.wait() }
    func open() { group.leave() }
}

/// Clipboard data an app hands over only when asked, counting the asks.
private final class LateProvider: NSObject, NSPasteboardItemDataProvider {
    var asked = 0

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        asked += 1
        item.setString("user text", forType: type)
    }
}

/// A pasteboard whose read fails: `pasteboardItems` nil, as macOS gives for an error.
private final class UnreadablePasteboard: NSPasteboard {
    override var pasteboardItems: [NSPasteboardItem]? { nil }
}

/// Another app's copy, made just as the paste's text is written (once, when `copyNext` is set).
private final class CopyingAfterWritePasteboard: NSPasteboard {
    static let copyNext = OSAllocatedUnfairLock(initialState: false)
    override func writeObjects(_ objects: [any NSPasteboardWriting]) -> Bool {
        let written = super.writeObjects(objects)
        if Self.copyNext.withLock({ copy in defer { copy = false }; return copy }) {
            clearContents()
            setString("copied as written", forType: .string)
        }
        return written
    }
}

/// An owner that never hands over the data it offers.
private final class GivesNothing: NSObject, NSPasteboardItemDataProvider {
    let asked = OSAllocatedUnfairLock(initialState: 0)
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        asked.withLock { $0 += 1 }
    }
}
