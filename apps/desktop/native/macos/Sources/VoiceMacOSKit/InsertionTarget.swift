// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import VoiceHelperSupport

/// What the paste finds as it comes: the dictation's field with its caret put back (`inPlace`), the
/// user in another app (`appChanged`), or a field or caret that could not be put back (`caretMoved`).
/// Only `inPlace` pastes (ADR-DESK-042).
enum InsertionOutcome: String, Equatable, Sendable {
    case inPlace
    case appChanged
    case caretMoved
}

/// The Accessibility calls an `InsertionTarget` makes, so the tests can stand in a field of their own.
protocol TextFieldAccess {
    associatedtype Element
    associatedtype Selection
    func focusedElement(inApp pid: pid_t) -> Element?
    func isSame(_ first: Element, _ second: Element) -> Bool
    func focus(_ element: Element)
    func selection(of element: Element) -> Selection?
    func select(_ selection: Selection, in element: Element)
    func isSame(_ first: Selection, _ second: Selection, in element: Element) -> Bool
}

/// Where a dictation's text goes: the app in front as it started (key-down), its focused field, and
/// the caret or selection in that field. The user may click elsewhere while the text is transcribed;
/// `restore` puts the field and caret back just before the paste, so the text lands where the user
/// spoke, or tells why it can't.
struct InsertionTarget<Access: TextFieldAccess> {
    let pid: pid_t
    /// Nil when the app showed no focused element: nothing is known of the caret, so none is put back.
    let element: Access.Element?
    /// Nil when the field showed no caret or selection.
    let selection: Access.Selection?

    /// The focused field of the app `pid` and its caret, now.
    static func capture(inApp pid: pid_t, access: Access) -> InsertionTarget {
        let element = access.focusedElement(inApp: pid)
        return InsertionTarget(pid: pid, element: element, selection: element.flatMap { access.selection(of: $0) })
    }

    /// Puts the captured field and caret back, with `frontmost` the app in front now. Never brings
    /// another app forward: the user left for it on purpose.
    func restore(frontmost: pid_t?, access: Access) -> InsertionOutcome {
        guard frontmost == pid else {
            HelperLog.debug("InsertionTarget: app \(pid) is no longer in front")
            return .appChanged
        }
        guard let element else { return .inPlace }
        if !isFocused(element, access: access) {
            HelperLog.debug("InsertionTarget: focus moved; focusing the field again")
            access.focus(element)
            guard isFocused(element, access: access) else {
                HelperLog.debug("InsertionTarget: the field would not take focus")
                return .caretMoved
            }
        }
        guard let selection else { return .inPlace }
        if isSelected(selection, in: element, access: access) { return .inPlace }
        HelperLog.debug("InsertionTarget: caret moved; putting it back")
        access.select(selection, in: element)
        guard isSelected(selection, in: element, access: access) else {
            HelperLog.debug("InsertionTarget: the caret would not go back")
            return .caretMoved
        }
        return .inPlace
    }

    private func isFocused(_ element: Access.Element, access: Access) -> Bool {
        access.focusedElement(inApp: pid).map { access.isSame($0, element) } ?? false
    }

    private func isSelected(_ selection: Access.Selection, in element: Access.Element, access: Access) -> Bool {
        access.selection(of: element).map { access.isSame($0, selection, in: element) } ?? false
    }
}

/// A field's caret or selection as Accessibility gives it: a text-marker range where the app has them
/// (WebKit, Chromium and Electron keep those current, while their character ranges can go stale), a
/// character range otherwise.
enum AXSelection {
    case marker(CFTypeRef)
    case range(CFRange)
}

/// The live Accessibility calls, each bounded by `HelperConfig.insertionTargetTimeout`. Blocking
/// cross-process calls: use off the main thread.
struct AXTextFieldAccess: TextFieldAccess {
    static let markerRangeAttribute = "AXSelectedTextMarkerRange"
    static let markerBoundsAttribute = "AXBoundsForTextMarkerRange"

    func focusedElement(inApp pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, HelperConfig.insertionTargetTimeout)
        guard let focused = CaretLocator.attribute(app, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, HelperConfig.insertionTargetTimeout)
        return element
    }

    func isSame(_ first: AXUIElement, _ second: AXUIElement) -> Bool {
        CFEqual(first, second)
    }

    func focus(_ element: AXUIElement) {
        let result = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        HelperLog.debug("InsertionTarget: focusing the field: \(result.rawValue)")
    }

    func selection(of element: AXUIElement) -> AXSelection? {
        if let marker = CaretLocator.attribute(element, Self.markerRangeAttribute) { return .marker(marker) }
        guard let value = CaretLocator.attribute(element, kAXSelectedTextRangeAttribute),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        return .range(range)
    }

    func select(_ selection: AXSelection, in element: AXUIElement) {
        let result: AXError
        switch selection {
        case .marker(let marker):
            result = AXUIElementSetAttributeValue(element, Self.markerRangeAttribute as CFString, marker)
        case .range(var range):
            guard let value = AXValueCreate(.cfRange, &range) else { return }
            result = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
        }
        HelperLog.debug("InsertionTarget: putting the caret back: \(result.rawValue)")
    }

    /// Two marker ranges are the same place when equal, or, since an app may describe one place with
    /// different markers, when both have the same bounds on screen now.
    func isSame(_ first: AXSelection, _ second: AXSelection, in element: AXUIElement) -> Bool {
        switch (first, second) {
        case (.range(let a), .range(let b)):
            return a.location == b.location && a.length == b.length
        case (.marker(let a), .marker(let b)):
            if CFEqual(a, b) { return true }
            guard let boundsA = markerBounds(a, in: element), let boundsB = markerBounds(b, in: element) else { return false }
            return boundsA == boundsB
        default:
            return false
        }
    }

    private func markerBounds(_ marker: CFTypeRef, in element: AXUIElement) -> CGRect? {
        guard let value = CaretLocator.parameterized(element, Self.markerBoundsAttribute, marker),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(value as! AXValue, .cgRect, &rect), rect.height > 0 else { return nil }
        return rect
    }
}

/// The insertion target of the dictation under way, captured at its key-down under the app's session
/// number for it. One at a time: a newer dictation's replaces it, and a paste for another session
/// finds none (`restore` then answers `caretMoved`: its caret is unknown).
@MainActor
final class InsertionTargets {
    /// AX elements are immutable handles, safe to pass between threads.
    struct Captured: @unchecked Sendable {
        let target: InsertionTarget<AXTextFieldAccess>
    }

    private var current: (session: Int, target: Captured)?

    func keep(_ target: Captured, session: Int) {
        current = (session, target)
    }

    func target(session: Int) -> Captured? {
        guard let current, current.session == session else { return nil }
        return current.target
    }
}
