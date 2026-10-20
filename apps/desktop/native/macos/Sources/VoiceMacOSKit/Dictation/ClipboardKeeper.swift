// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import os
import VoiceHelperSupport

/// The clipboard a paste writes, and what it held before, put back after the paste
/// (DECISIONS.md ADR-DESK-002, amended 2026-10-08 and 2026-10-20).
///
/// The paste never waits for the clipboard to be read. Reading it asks the app that owns it for
/// every item's data, which a busy app hands over late, so the clipboard is saved ahead, off the
/// main actor, while the user speaks (`save`, which the app asks for again and again from key-down
/// until the paste; the newest save is the one put back). A paste that comes before the save is done goes ahead and leaves its text on the
/// clipboard. The clipboard goes back `restoreDelay` after an app reads the paste's text (offered
/// through `OfferedText`, which hands it over when asked), or `readWait` after the paste keys when no
/// app has read it by then: a busy app handles the keys late, and one that read the clipboard as it
/// was would paste that. It goes back only while the clipboard still holds the paste's text and was
/// saved as it was just before the paste (its `changeCount`): a copy made in between is never
/// overwritten. One read runs at a time: a save asked for while one is
/// still reading is skipped, so an owner that never answers holds one read, not one per copy. A
/// clipboard put back is read again by the next save. A clipboard marked concealed (a password manager's) is not
/// saved, and is not put back, where its manager would no longer clear it.
@MainActor
final class ClipboardKeeper {
    /// Marker types from nspasteboard.org: clipboard managers skip items carrying them, so the
    /// dictated text does not pollute clipboard history.
    nonisolated static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    nonisolated static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")

    /// Every item's data, by type.
    typealias Items = [[NSPasteboard.PasteboardType: Data]]
    /// Reads a clipboard's items; nil for one that is not to be saved. Runs off the main actor.
    typealias Reader = @Sendable (_ pasteboard: NSPasteboard, _ rules: SharedRequest.ClipboardRules) -> Items?
    /// Waits out a put-back's delay, in milliseconds.
    typealias Delay = @Sendable (_ milliseconds: Int) async -> Void

    nonisolated(unsafe) let pasteboard: NSPasteboard
    private let rules: SharedRequest.ClipboardRules
    private let read: Reader
    private let delay: Delay
    /// The user's clipboard as saved (nil items for one not to be saved), and the change count it
    /// holds for: the pasteboard's as it was read, then a paste's written over it.
    private var saved: (changeCount: Int, items: Items?)?
    /// The change count of the save still to be kept, if any: a paste drops it.
    private var saving: Int?
    /// The latest paste's text as offered, and the change count its write gave; read off the main
    /// actor as the helper ends (`handOver`).
    nonisolated let offered = OSAllocatedUnfairLock<(changeCount: Int, text: OfferedText)?>(initialState: nil)
    /// A read is running, kept or not.
    private var reading = false
    /// The latest save, and the latest put-back, under way or done.
    private(set) var saveTask: Task<Void, Never>?
    private(set) var restoreTask: Task<Void, Never>?

    init(pasteboard: NSPasteboard = .general, rules: SharedRequest.ClipboardRules = SharedRequest.clipboardRules,
         read: @escaping Reader = ClipboardKeeper.readItems,
         delay: @escaping Delay = { try? await Task.sleep(for: .milliseconds($0)) }) {
        self.pasteboard = pasteboard
        self.rules = rules
        self.read = read
        self.delay = delay
    }

    /// Saves the clipboard in the background, unless it is saved, or being saved, as it is now.
    func save() {
        let changeCount = pasteboard.changeCount
        guard saved?.changeCount != changeCount, saving != changeCount else {
            HelperLog.debug("ClipboardKeeper: clipboard unchanged since it was saved")
            return
        }
        guard !reading else {
            HelperLog.debug("ClipboardKeeper: a save still reading; not saved again")
            return
        }
        reading = true
        saving = changeCount
        let started = ContinuousClock.now
        nonisolated(unsafe) let pasteboard = pasteboard
        let read = read, rules = rules
        saveTask = Task.detached { [weak self] in
            let items = read(pasteboard, rules)
            await self?.finishSave(items, at: changeCount, started: started)
        }
    }

    private func finishSave(_ items: Items?, at changeCount: Int, started: ContinuousClock.Instant) {
        reading = false
        // A paste took its place.
        guard saving == changeCount else { return }
        saving = nil
        // Copied over while it was read: what was read is not the clipboard as it is.
        guard pasteboard.changeCount == changeCount else {
            HelperLog.debug("ClipboardKeeper: clipboard changed while it was saved; not kept")
            return
        }
        saved = (changeCount, items)
        HelperLog.debug("ClipboardKeeper: clipboard \(items == nil ? "not to be saved" : "saved") after \(Self.milliseconds(since: started))ms")
    }

    /// Writes `text` over the clipboard for a paste, marked transient and concealed, returning the
    /// pasteboard's change count with it. The saved clipboard now holds while the text is there. The
    /// text is handed over when an app asks for it, so the put-back knows an app has read it.
    func write(_ text: String) -> Int {
        let before = pasteboard.changeCount
        // The count the clear gives is the text's own: one read after the write may be a newer copy's.
        let ours = pasteboard.clearContents()
        let offered = OfferedText(text)
        pasteboard.writeObjects([Self.item(offering: offered)])
        self.offered.withLock { $0 = (ours, offered) }
        if let kept = saved, kept.changeCount == before {
            saved = (ours, kept.items)
        } else {
            HelperLog.debug("ClipboardKeeper: \(saving == nil ? "no save of the clipboard as it was" : "the clipboard's save still under way"); it won't be put back")
            saved = nil
        }
        // A save under way read a clipboard this write replaced.
        saving = nil
        return ours
    }

    /// Puts the saved clipboard back `restoreDelay` after an app reads the paste's text, or once
    /// `readWait` from now passes with no app having read it, if the pasteboard still holds the
    /// paste's text (`ours`, its change count).
    func restore(after ours: Int) {
        let started = ContinuousClock.now
        // A later paste's text replaced it: that paste's put-back is the one to wait for its read.
        let text = offered.withLock { $0?.changeCount == ours ? $0?.text : nil }
        restoreTask = Task { [weak self, rules, delay] in
            if let text, !text.wasRead {
                let timer = Task { await delay(rules.readWait); text.endWait() }
                let read = await text.waitForRead()
                timer.cancel()
                HelperLog.debug(read
                    ? "ClipboardKeeper: the paste's text read after \(Self.milliseconds(since: started))ms"
                    : "ClipboardKeeper: no app read the paste's text in \(rules.readWait)ms")
            }
            await delay(rules.restoreDelay)
            self?.putBack(ours, started: started)
        }
    }

    private func putBack(_ ours: Int, started: ContinuousClock.Instant) {
        guard let kept = saved, kept.changeCount == ours, let items = kept.items else {
            HelperLog.debug("ClipboardKeeper: nothing saved to put back; the paste's text stays")
            return
        }
        // Built before the check, so nothing but the check stands between it and the clear: macOS has
        // no conditional write, and a copy that lands in between is overwritten.
        let objects = items.map { entry in
            let item = NSPasteboardItem()
            for (type, data) in entry { item.setData(data, forType: type) }
            return item
        }
        guard pasteboard.changeCount == ours else {
            HelperLog.debug("ClipboardKeeper: clipboard changed since the paste; not put back")
            return
        }
        pasteboard.clearContents()
        if !objects.isEmpty { pasteboard.writeObjects(objects) }
        // Not kept: the change count read now may already be a newer copy's, so the next save reads
        // the clipboard again.
        saved = nil
        HelperLog.debug("ClipboardKeeper: clipboard put back after \(Self.milliseconds(since: started))ms")
    }

    /// Writes a paste's text no app has read yet in full, so the clipboard still holds it once the
    /// helper is gone (macOS asks no exited process for its data). Run as the helper ends, on its
    /// input's thread.
    nonisolated func handOver() {
        guard let (changeCount, text) = offered.withLock({ $0 }), !text.wasRead, pasteboard.changeCount == changeCount else { return }
        pasteboard.clearContents()
        pasteboard.writeObjects([Self.item(offering: text, inFull: true)])
        HelperLog.debug("ClipboardKeeper: the paste's text no app read kept as the helper ends")
    }

    /// The paste's item: its text handed over when an app asks for it, or written `inFull`; marked
    /// transient and concealed.
    private nonisolated static func item(offering text: OfferedText, inFull: Bool = false) -> NSPasteboardItem {
        let item = NSPasteboardItem()
        if inFull { item.setString(text.text, forType: .string) } else { item.setDataProvider(text, forTypes: [.string]) }
        item.setString("", forType: transientType)
        item.setString("", forType: concealedType)
        return item
    }

    /// Every item's data, by type; nil for a clipboard that can't be read (or an item of it whose owner
    /// gives none of its data), one marked concealed, or one with more formats or data than `rules`
    /// allow. A concealed one is told by its types, before any data is asked for.
    nonisolated static func readItems(_ pasteboard: NSPasteboard, _ rules: SharedRequest.ClipboardRules) -> Items? {
        // nil is a failed read (an empty clipboard has no items): put back, it would clear the clipboard.
        guard let items = pasteboard.pasteboardItems else { return nil }
        let types = items.map(\.types)
        guard !types.joined().contains(concealedType), types.joined().count <= rules.maxFormats else { return nil }
        var bytes = 0
        var saved: Items = []
        for (item, types) in zip(items, types) {
            var entry: [NSPasteboard.PasteboardType: Data] = [:]
            for type in types {
                guard let data = item.data(forType: type) else { continue }
                bytes += data.count
                guard bytes <= rules.maxBytes else { return nil }
                entry[type] = data
            }
            // An item whose owner gave none of its data was not read: put back, it would be empty.
            guard !entry.isEmpty else { return nil }
            saved.append(entry)
        }
        return saved
    }

    nonisolated static func milliseconds(since start: ContinuousClock.Instant) -> Int {
        Int((start.duration(to: .now) / .milliseconds(1)).rounded())
    }
}

/// A paste's text, handed to an app only when it reads the clipboard, so the put-back knows an app
/// has it before the clipboard as it was goes back (ADR-DESK-002, amended 2026-10-20). macOS asks on
/// the main thread for another app's read, on the reading thread for this process's own.
final class OfferedText: NSObject, NSPasteboardItemDataProvider, Sendable {
    private struct State {
        var read = false
        var ended = false
        var waiter: CheckedContinuation<Bool, Never>?
    }

    let text: String
    private let state = OSAllocatedUnfairLock(initialState: State())

    init(_ text: String) {
        self.text = text
    }

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        item.setString(text, forType: type)
        end(read: true)
    }

    /// An app has read the text.
    var wasRead: Bool { state.withLock { $0.read } }

    /// Waits until an app reads the text (true) or `endWait` (false).
    func waitForRead() async -> Bool {
        await withCheckedContinuation { continuation in
            let ended: Bool? = state.withLock { state in
                guard !state.ended else { return state.read }
                state.waiter = continuation
                return nil
            }
            if let ended { continuation.resume(returning: ended) }
        }
    }

    /// Ends the wait for a read, as none came in time.
    func endWait() { end(read: false) }

    private func end(read: Bool) {
        let waiter = state.withLock { state -> CheckedContinuation<Bool, Never>? in
            guard !state.ended else { return nil }
            state.ended = true
            state.read = read
            defer { state.waiter = nil }
            return state.waiter
        }
        waiter?.resume(returning: read)
    }
}
