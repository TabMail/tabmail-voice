// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices

/// Finds where the text will land in the frontmost app, via Accessibility, so the dictation
/// overlay can appear there: the text cursor (caret) if the app exposes it, otherwise the focused
/// text field.
enum CaretLocator {
    /// The anchor's screen rect in Cocoa coordinates (bottom-left origin), or nil when the app
    /// exposes neither a caret nor a field-sized focused element (then the caller uses the mouse
    /// pointer). Blocking cross-process Accessibility calls, each bounded by
    /// `DictationConfig.caretLookupTimeout`: call off the main thread.
    static func anchorRect(inApp pid: pid_t) -> CGRect? {
        // Ask the frontmost app itself: the system-wide focused element is unreliable in some
        // apps (it can fail or lag behind the app's own focus).
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, DictationConfig.caretLookupTimeout)
        guard let focused = attribute(app, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            Log.debug("CaretLocator: no focused element")
            return nil
        }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, DictationConfig.caretLookupTimeout)
        let screens = NSScreen.screens.map(\.frame)
        guard let primaryHeight = screens.first?.height else { return nil }

        if let caret = caretRect(in: element) {
            let rect = cocoaRect(fromAccessibility: caret, primaryScreenHeight: primaryHeight)
            if isPlausible(rect, screens: screens) { return rect }
            Log.debug("CaretLocator: ignoring an off-screen caret rect")
        }
        if let frame = frame(of: element) {
            let rect = cocoaRect(fromAccessibility: frame, primaryScreenHeight: primaryHeight)
            if rect.height <= DictationConfig.focusedElementMaxAnchorHeight, isPlausible(rect, screens: screens) {
                Log.debug("CaretLocator: no caret; anchoring to the focused field")
                return rect
            }
        }
        Log.debug("CaretLocator: no caret or field-sized focused element")
        return nil
    }

    /// Some apps answer with a placeholder rect (all zero, or off every screen) instead of an
    /// error; anchoring there would put the overlay in a screen corner.
    static func isPlausible(_ rect: CGRect, screens: [CGRect]) -> Bool {
        guard rect.origin != .zero, rect.height > 0 else { return false }
        return screens.contains { $0.intersects(rect) }
    }

    private static func caretRect(in element: AXUIElement) -> CGRect? {
        guard let rangeValue = attribute(element, kAXSelectedTextRangeAttribute),
              CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) else { return nil }

        if let caret = bounds(of: range, in: element) { return caret }
        // A collapsed caret often reports an empty rect: use the trailing edge of the character
        // before it instead.
        guard range.location > 0,
              let previous = bounds(of: CFRange(location: range.location - 1, length: 1), in: element) else { return nil }
        return CGRect(x: previous.maxX, y: previous.minY, width: 1, height: previous.height)
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        return CGRect(origin: origin, size: extent)
    }

    /// Accessibility rects are top-left-origin relative to the primary screen; AppKit's are
    /// bottom-left-origin.
    static func cocoaRect(fromAccessibility rect: CGRect, primaryScreenHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryScreenHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func bounds(of range: CFRange, in element: AXUIElement) -> CGRect? {
        var range = range
        guard let rangeValue = AXValueCreate(.cfRange, &range) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element, kAXBoundsForRangeParameterizedAttribute as CFString, rangeValue, &value
        ) == .success, let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(value as! AXValue, .cgRect, &rect), rect.height > 0 else { return nil }
        return rect
    }
}
