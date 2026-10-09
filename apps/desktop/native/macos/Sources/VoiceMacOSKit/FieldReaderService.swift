// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// `voice-field-reader`'s requests, over `HelperChannel`: the read of the focused field that
/// correction learning watches, in a program of its own, so a read stuck in an app's Accessibility
/// replies holds up no paste, caret or microphone, and the app can end it (`FieldReader` in the app).
/// `voice-macos` doesn't serve it.
///
/// - `focusedFieldValue {pid, maxLength, excludedAppIDs, excludedHosts}` → `{value}`: the text of
///   the focused field of `pid`, the app the dictation was pasted into as `voice-macos` named it at
///   key-down (never what is in front after the paste), null for none, a password field
///   (`FocusedField`), or one in an app or on a website the user excludes from screen reading, which
///   is not read. The shared core (`SharedRequest`) checks `maxLength`, sends null for a field
///   longer than it in UTF-16 code units, and takes secret-looking text out of the rest.
public enum FieldReaderService {
    @MainActor
    public static func register(on channel: HelperChannel) {
        register(on: channel, screen: .accessibility)
    }

    /// `screen` reads through Accessibility, or is a test's stand-in.
    @MainActor
    static func register(on channel: HelperChannel, screen: ScreenAccess) {
        channel.on("focusedFieldValue") { params in
            guard let pid = params["pid"]?.integer.flatMap({ pid_t(exactly: $0) }) else {
                throw HelperError("focusedFieldValue needs pid and maxLength")
            }
            let maxLength = try SharedRequest.fieldBound(params["maxLength"])
            let exclusions = try ScreenExclusions(params: params, method: "focusedFieldValue")
            if exclusions.excludesApp(screen.bundleIdentifier(pid)) {
                HelperLog.debug("FocusedField: the app is excluded from screen reading; not read")
                return ["value": .null]
            }
            // Blocking Accessibility calls: off the main thread, which answers the requests.
            return await Task.detached { (try? SharedRequest.fieldValue(screen.focusedField(pid, exclusions), maxLength: maxLength)) ?? ["value": .null] }.value
        }
    }
}
