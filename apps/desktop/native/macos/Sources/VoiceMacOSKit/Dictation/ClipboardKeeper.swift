// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import VoiceHelperSupport

/// The clipboard a paste writes, and what it held before, put back after the paste
/// (DECISIONS.md ADR-DESK-002, amended 2026-10-08).
///
/// The paste never waits for the clipboard to be read. Reading it asks the app that owns it for
/// every item's data, which a busy app hands over late, so the clipboard is saved ahead, off the
/// main actor, while the user speaks (`save`, which the app asks for again and again from key-down
/// until the paste; the newest save is the one put back). A paste that comes before the save is done goes ahead and leaves its text on the
/// clipboard. The clipboard goes back `restoreDelay` after the paste keys, and only while it still
/// holds the paste's text and was saved as it was just before the paste (its `changeCount`): a copy
/// made in between is never overwritten. One read runs at a time: a save asked for while one is
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

    let pasteboard: NSPasteboard
    private let rules: SharedRequest.ClipboardRules
    private let read: Reader
    private let delay: Delay
    /// The user's clipboard as saved (nil items for one not to be saved), and the change count it
    /// holds for: the pasteboard's as it was read, then a paste's written over it.
    private var saved: (changeCount: Int, items: Items?)?
    /// The change count of the save still to be kept, if any: a paste drops it.
    private var saving: Int?
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
    /// pasteboard's change count with it. The saved clipboard now holds while the text is there.
    func write(_ text: String) -> Int {
        let before = pasteboard.changeCount
        // The count the clear gives is the text's own: one read after the write may be a newer copy's.
        let ours = pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setString("", forType: Self.transientType)
        item.setString("", forType: Self.concealedType)
        pasteboard.writeObjects([item])
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

    /// Puts the saved clipboard back `restoreDelay` from now, if the pasteboard still holds the
    /// paste's text (`ours`, its change count).
    func restore(after ours: Int) {
        let started = ContinuousClock.now
        restoreTask = Task { [weak self, rules, delay] in
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
