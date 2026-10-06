// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Carbon.HIToolbox
import VoiceHelperSupport

/// Inserts text into whatever field has focus in the frontmost app, by pasting.
///
/// Pasting (write pasteboard → ⌘V) is the one insertion path that works in native, Electron and
/// browser text fields alike; setting `kAXSelectedTextAttribute` silently fails in most web views
/// (DECISIONS.md ADR-DESK-002). The clipboard is only written, never read: the text stays on it.
@MainActor
struct TextInserter {
    /// Marker types from nspasteboard.org: clipboard managers skip items carrying them, so the
    /// dictated text does not pollute clipboard history.
    static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")

    let pasteboard: NSPasteboard
    /// Posts ⌘V. Injected so tests can exercise the pasteboard handling without posting events.
    let pasteKeystroke: @MainActor () async -> Void

    init(pasteboard: NSPasteboard = .general, pasteKeystroke: @escaping @MainActor () async -> Void = TextInserter.postCommandV) {
        self.pasteboard = pasteboard
        self.pasteKeystroke = pasteKeystroke
    }

    func insert(_ text: String) async {
        let started = ContinuousClock.now
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setString("", forType: Self.transientType)
        item.setString("", forType: Self.concealedType)
        pasteboard.writeObjects([item])
        HelperLog.debug("TextInserter: clipboard written after \(Self.milliseconds(since: started))ms")
        await pasteKeystroke()
        HelperLog.debug("TextInserter: paste keystroke sent after \(Self.milliseconds(since: started))ms")
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> Int {
        Int((start.duration(to: .now) / .milliseconds(1)).rounded())
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
            HelperLog.error("TextInserter: could not create keystroke events for key \(keyCode)")
            return
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        try? await Task.sleep(for: HelperConfig.pasteKeystrokeGap)
        up.post(tap: .cghidEventTap)
    }
}
