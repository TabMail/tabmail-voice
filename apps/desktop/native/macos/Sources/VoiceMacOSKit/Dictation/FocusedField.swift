// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import VoiceHelperSupport

/// The text of an app's focused field, read after a dictation's paste so the app can learn the user's
/// corrections to it (ADR-DESK-038). Never a password field's, and never one in a page of an excluded
/// website; the shared core decides how long one may be (`SharedRequest.fieldValue`).
enum FocusedField {
    /// What a read found: a field's text, or a terminal's viewport as the screen read takes it, whose
    /// box around the cursor the shared core cuts out as the field (`terminal_box`): a terminal's
    /// text is its whole scrollback, and its other panes and programs' lines are not the field.
    enum Read: Equatable, Sendable {
        case text(String)
        case terminal(JSON)
    }

    /// The focused field of the app `pid`, as `value(inApp:excluding:)` reads it, or a terminal's
    /// viewport when the app is a terminal (`HelperConfig.terminalBundleIDs`, as the screen read
    /// decides): nil when there is none to read.
    static func read(inApp pid: pid_t, bundleID: String?, excluding exclusions: ScreenExclusions) -> Read? {
        read(bundleID: bundleID, text: { value(inApp: pid, excluding: exclusions) }, viewport: {
            ScreenContextReader.read(pid: pid, appName: "", bundleID: bundleID, excluding: exclusions)?.terminalSource
        })
    }

    /// A terminal's field is read by its `viewport` only, never by its whole `text`; any other app's
    /// by its `text`.
    static func read(bundleID: String?, text: () -> String?, viewport: () -> JSON?) -> Read? {
        guard let bundleID, HelperConfig.terminalBundleIDs.contains(bundleID) else { return text().map(Read.text) }
        guard let viewport = viewport() else {
            HelperLog.debug("FocusedField: the terminal's viewport could not be read")
            return nil
        }
        return .terminal(viewport)
    }

    /// The focused field's whole text in the app `pid`, or nil when there is no focused element, it
    /// has no text, it is a password field, or its window shows a page of an excluded website.
    /// Blocking cross-process Accessibility calls: call off the main thread. Those on the focused
    /// element are bounded by `HelperConfig.focusedFieldTimeout`; those on what is above and inside
    /// it (looked at for pages only) by the system-wide default.
    static func value(inApp pid: pid_t, excluding exclusions: ScreenExclusions) -> String? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, HelperConfig.focusedFieldTimeout)
        guard let focused = CaretLocator.attribute(app, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            HelperLog.debug("FocusedField: no focused element")
            return nil
        }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, HelperConfig.focusedFieldTimeout)
        return value(of: element, above: ScreenContextReader.ancestors(of: element), in: LiveScreenTree(), excluding: exclusions)
    }

    /// The focused element's text, as `value(inApp:excluding:)` has it; `focusPath` is what
    /// is above the element. A page of an excluded website in the element's window is looked for before
    /// the text is asked for.
    static func value<Tree: ScreenTree>(of element: Tree.Element, above focusPath: [Tree.Element], in tree: Tree,
                                        excluding exclusions: ScreenExclusions) -> String? {
        let started = Date()
        func holdsExcludedPage(_ element: Tree.Element, intoPages: Bool) -> Bool {
            ScreenContextReader.holdsExcludedPage(element, in: tree, excluding: exclusions, intoPages: intoPages,
                                                  within: HelperConfig.focusedFieldPageScanBudget, since: started)
        }
        // The field's own pages, what it holds, then the rest of its window: with the caret in a
        // browser's address field, the page it shows is beside the field, not above it.
        let window = focusPath.last { tree.string($0, kAXRoleAttribute) == kAXWindowRole as String }
        if ScreenContextReader.pageHosts(of: element, above: focusPath, in: tree).contains(where: exclusions.excludes)
            || holdsExcludedPage(element, intoPages: true) || window.map({ holdsExcludedPage($0, intoPages: false) }) ?? false {
            HelperLog.debug("FocusedField: the window shows a page of an excluded website, or one whose address is unknown; not read")
            return nil
        }
        // The value is asked for only once the field is known not to be a password field.
        let subrole = tree.string(element, kAXSubroleAttribute)
        return readable(subrole: subrole, value: subrole == kAXSecureTextFieldSubrole ? nil : tree.string(element, kAXValueAttribute))
    }

    /// `value`, unless it is a password field's (`subrole`) or missing.
    static func readable(subrole: String?, value: String?) -> String? {
        if subrole == kAXSecureTextFieldSubrole {
            HelperLog.debug("FocusedField: a password field; not read")
            return nil
        }
        guard let value else {
            HelperLog.debug("FocusedField: no text")
            return nil
        }
        return value
    }
}
