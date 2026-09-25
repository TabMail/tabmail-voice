// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices

/// Finds the text cursor (caret) of the focused field in the frontmost app, via Accessibility,
/// so the dictation overlay can appear where the text will land.
enum CaretLocator {
    /// The caret's screen rect in Cocoa coordinates (bottom-left origin), or nil when the focused
    /// app doesn't expose one (many Electron apps, terminals). Blocking cross-process
    /// Accessibility calls, bounded by `DictationConfig.caretLookupTimeout`: call off the main thread.
    static func caretRect() -> CGRect? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, DictationConfig.caretLookupTimeout)
        guard let focused = attribute(system, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, DictationConfig.caretLookupTimeout)

        guard let rangeValue = attribute(element, kAXSelectedTextRangeAttribute),
              CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) else { return nil }

        var caret = bounds(of: range, in: element)
        // A collapsed caret often reports an empty rect: use the trailing edge of the character
        // before it instead.
        if caret == nil, range.location > 0,
           let previous = bounds(of: CFRange(location: range.location - 1, length: 1), in: element) {
            caret = CGRect(x: previous.maxX, y: previous.minY, width: 1, height: previous.height)
        }
        guard let caret, let primary = NSScreen.screens.first else { return nil }
        return cocoaRect(fromAccessibility: caret, primaryScreenHeight: primary.frame.height)
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
