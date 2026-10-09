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
/// (DECISIONS.md ADR-DESK-002). The paste never waits on the clipboard as it was: `ClipboardKeeper`
/// saved it ahead and puts it back after the paste keys, in the background.
@MainActor
struct TextInserter {
    let clipboard: ClipboardKeeper
    /// Posts ⌘V. Injected so tests can exercise the pasteboard handling without posting events.
    let pasteKeystroke: @MainActor () async -> Void

    init(clipboard: ClipboardKeeper, pasteKeystroke: @escaping @MainActor () async -> Void = TextInserter.postCommandV) {
        self.clipboard = clipboard
        self.pasteKeystroke = pasteKeystroke
    }

    func insert(_ text: String) async {
        let started = ContinuousClock.now
        let ours = clipboard.write(text)
        HelperLog.debug("TextInserter: clipboard written after \(ClipboardKeeper.milliseconds(since: started))ms")
        await pasteKeystroke()
        HelperLog.debug("TextInserter: paste keystroke sent after \(ClipboardKeeper.milliseconds(since: started))ms")
        clipboard.restore(after: ours)
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
