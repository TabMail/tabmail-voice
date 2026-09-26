// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Carbon.HIToolbox

/// Inserts text into whatever field has focus in the frontmost app, by pasting.
///
/// Pasting (write pasteboard → ⌘V → restore pasteboard) is the one insertion path that works
/// in native, Electron and browser text fields alike; setting `kAXSelectedTextAttribute`
/// silently fails in most web views (DECISIONS.md ADR-DESK-002).
@MainActor
struct TextInserter {
    /// Marker types from nspasteboard.org: clipboard managers skip items carrying them, so the
    /// dictated text does not pollute clipboard history.
    static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")

    let pasteboard: NSPasteboard
    /// Posts ⌘V. Injected so tests can exercise the pasteboard handling without posting events.
    let pasteKeystroke: @MainActor () async -> Void
    let restoreDelay: Duration

    init(
        pasteboard: NSPasteboard = .general,
        restoreDelay: Duration = DictationConfig.clipboardRestoreDelay,
        pasteKeystroke: @escaping @MainActor () async -> Void = TextInserter.postCommandV
    ) {
        self.pasteboard = pasteboard
        self.restoreDelay = restoreDelay
        self.pasteKeystroke = pasteKeystroke
    }

    func insert(_ text: String) async {
        let saved = PasteboardSnapshot(pasteboard)

        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setString("", forType: Self.transientType)
        item.setString("", forType: Self.concealedType)
        pasteboard.writeObjects([item])
        let ourChangeCount = pasteboard.changeCount

        await pasteKeystroke()
        try? await Task.sleep(for: restoreDelay)

        // If something else wrote the pasteboard meanwhile (the user copied), keep theirs.
        guard pasteboard.changeCount == ourChangeCount else {
            Log.debug("TextInserter: pasteboard changed during insertion; not restoring")
            return
        }
        saved.restore(to: pasteboard)
    }

    static func postCommandV() async {
        // Explicit flags: only ⌘, even if the user is still holding the hotkey modifier.
        await postKeystroke(CGKeyCode(kVK_ANSI_V), flags: .maskCommand)
    }

    /// Posts one key press to the frontmost app, with exactly `flags` held.
    static func postKeystroke(_ keyCode: CGKeyCode, flags: CGEventFlags) async {
        let source = CGEventSource(stateID: .combinedSessionState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        else {
            Log.error("TextInserter: could not create keystroke events for key \(keyCode)")
            return
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        try? await Task.sleep(for: DictationConfig.pasteKeystrokeGap)
        up.post(tap: .cghidEventTap)
    }
}

/// A full copy of every item and type on a pasteboard, so it can be put back verbatim.
struct PasteboardSnapshot {
    private let items: [[NSPasteboard.PasteboardType: Data]]

    init(_ pasteboard: NSPasteboard) {
        items = (pasteboard.pasteboardItems ?? []).map { item in
            var entry: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { entry[type] = data }
            }
            return entry
        }
    }

    var isEmpty: Bool { items.isEmpty }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        guard !items.isEmpty else { return }
        let restored = items.map { entry in
            let item = NSPasteboardItem()
            for (type, data) in entry { item.setData(data, forType: type) }
            return item
        }
        pasteboard.writeObjects(restored)
    }
}
