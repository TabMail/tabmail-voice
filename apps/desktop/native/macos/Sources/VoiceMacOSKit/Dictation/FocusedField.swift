// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import VoiceHelperSupport

/// The text of an app's focused field, read after a dictation's paste so the app can learn the user's
/// corrections to it (ADR-DESK-038). Never a password field's, and nothing past `maxLength`.
enum FocusedField {
    /// The focused field's whole text in the app `pid`, or nil when there is no focused element, it
    /// has no text, it is a password field, or its text is longer than `maxLength` UTF-16 code units.
    /// Blocking cross-process Accessibility calls, each bounded by `HelperConfig.focusedFieldTimeout`:
    /// call off the main thread.
    static func value(inApp pid: pid_t, maxLength: Int) -> String? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, HelperConfig.focusedFieldTimeout)
        guard let focused = CaretLocator.attribute(app, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            HelperLog.debug("FocusedField: no focused element")
            return nil
        }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, HelperConfig.focusedFieldTimeout)
        return readable(
            subrole: CaretLocator.attribute(element, kAXSubroleAttribute) as? String,
            value: CaretLocator.attribute(element, kAXValueAttribute) as? String,
            maxLength: maxLength
        )
    }

    /// `value`, unless it is a password field's (`subrole`), missing, or longer than `maxLength`.
    static func readable(subrole: String?, value: String?, maxLength: Int) -> String? {
        if subrole == kAXSecureTextFieldSubrole {
            HelperLog.debug("FocusedField: a password field; not read")
            return nil
        }
        guard let value else {
            HelperLog.debug("FocusedField: no text")
            return nil
        }
        guard value.utf16.count <= maxLength else {
            HelperLog.debug("FocusedField: \(value.utf16.count) code units, over \(maxLength)")
            return nil
        }
        return value
    }
}
