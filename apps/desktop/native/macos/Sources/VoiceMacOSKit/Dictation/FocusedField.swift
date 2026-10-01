// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import VoiceHelperSupport

/// The text of an app's focused field, read after a dictation's paste so the app can learn the user's
/// corrections to it (ADR-DESK-038). Never a password field's, never one in a page of an excluded
/// website, and nothing past `maxLength`.
enum FocusedField {
    /// The focused field's whole text in the app `pid`, or nil when there is no focused element, it
    /// has no text, it is a password field, it is in a page of an excluded website, or its text is
    /// longer than `maxLength` UTF-16 code units.
    /// Blocking cross-process Accessibility calls, each bounded by `HelperConfig.focusedFieldTimeout`:
    /// call off the main thread.
    static func value(inApp pid: pid_t, maxLength: Int, excluding exclusions: ScreenExclusions) -> String? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, HelperConfig.focusedFieldTimeout)
        guard let focused = CaretLocator.attribute(app, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            HelperLog.debug("FocusedField: no focused element")
            return nil
        }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, HelperConfig.focusedFieldTimeout)
        return value(of: element, above: ScreenContextReader.ancestors(of: element), in: LiveScreenTree(), maxLength: maxLength,
                     excluding: exclusions)
    }

    /// The focused element's text, as `value(inApp:maxLength:excluding:)` has it; `focusPath` is what
    /// is above the element. A page of an excluded website is checked before the text is asked for.
    static func value<Tree: ScreenTree>(of element: Tree.Element, above focusPath: [Tree.Element], in tree: Tree, maxLength: Int,
                                        excluding exclusions: ScreenExclusions) -> String? {
        if ScreenContextReader.pageHosts(of: element, above: focusPath, in: tree).contains(where: exclusions.excludesHost) {
            HelperLog.debug("FocusedField: in a page of a website excluded from screen reading; not read")
            return nil
        }
        return readable(subrole: tree.string(element, kAXSubroleAttribute), value: tree.string(element, kAXValueAttribute), maxLength: maxLength)
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
