// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// `voice-hotkey`'s requests, over `HelperChannel`:
/// - `configure {hotkey, tapMaxDuration, doubleTapWindow}` (seconds) → `{installed}`: sets the
///   gesture and (re)installs the tap; call it again once Accessibility is granted.
/// - `dictationEnded` → `{}`: nothing listens hands-free (the dictation ended without the hotkey, or a
///   double tap's release found no dictation listening).
/// - `setChatOpen {isOpen}` → `{}`: the chat window opened or closed (Escape closes it while open).
/// and its event `{"event": "action", "action": "start" | "startHandsFree" | "listenHandsFree" | "finish" | "cancel" | "toggleMode" | "closeChat"}`.
public enum HotkeyService {
    @MainActor
    public static func register(on channel: HelperChannel) -> HotkeyMonitor {
        let monitor = HotkeyMonitor(
            gesture: PushToTalkGesture(hotkey: .rightOption, tapMaxDuration: 0, doubleTapWindow: 0),
            onAction: { action in channel.emit("action", ["action": .string(action.rawValue)]) }
        )
        channel.on("configure") { params in
            guard let raw = params["hotkey"]?.string, let hotkey = DictationHotkey(rawValue: raw),
                  let tapMaxDuration = params["tapMaxDuration"]?.number,
                  let doubleTapWindow = params["doubleTapWindow"]?.number else {
                throw HelperError("configure needs hotkey, tapMaxDuration and doubleTapWindow")
            }
            return await MainActor.run {
                monitor.configure(PushToTalkGesture(hotkey: hotkey, tapMaxDuration: tapMaxDuration, doubleTapWindow: doubleTapWindow))
                if !monitor.isInstalled { monitor.install() }
                return ["installed": .bool(monitor.isInstalled)]
            }
        }
        channel.on("dictationEnded") { _ in
            await MainActor.run { monitor.dictationEnded() }
            return [:]
        }
        channel.on("setChatOpen") { params in
            guard let isOpen = params["isOpen"]?.bool else { throw HelperError("setChatOpen needs isOpen") }
            await MainActor.run { monitor.setChatOpen(isOpen) }
            return [:]
        }
        return monitor
    }
}
