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
        Log.debug("CaretLocator: app \(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "?"), focused role \(attribute(element, kAXRoleAttribute) as? String ?? "?")")
        let screens = NSScreen.screens.map(\.frame)
        guard let primaryHeight = screens.first?.height else { return nil }

        // Text markers first: Chromium/Electron and WebKit keep them current as the caret moves,
        // while their index-based range answers can go stale or empty after typing.
        for (source, caret) in [("text marker", markerCaretRect(in: element)), ("text range", caretRect(in: element))] {
            guard let caret else {
                Log.debug("CaretLocator: \(source): none")
                continue
            }
            let rect = caretEdge(of: cocoaRect(fromAccessibility: caret, primaryScreenHeight: primaryHeight))
            Log.debug("CaretLocator: \(source): \(caret) (screen \(rect))")
            if isPlausible(rect, screens: screens) { return rect }
            Log.debug("CaretLocator: \(source): ignoring an implausible rect")
        }
        if let frame = frame(of: element) {
            let rect = cocoaRect(fromAccessibility: frame, primaryScreenHeight: primaryHeight)
            if rect.height <= DictationConfig.focusedElementMaxAnchorHeight, isPlausible(rect, screens: screens) {
                Log.debug("CaretLocator: no caret; anchoring to the focused field \(frame)")
                return rect
            }
        }
        Log.debug("CaretLocator: no caret or field-sized focused element")
        return nil
    }

    /// Some apps answer a caret query with a whole line's box instead of a caret: Chromium at the
    /// very start of a field (e.g. over its placeholder), terminals at a wrapped line. The caret is
    /// at that box's leading edge; centring on the box would put the overlay mid-line.
    static func caretEdge(of rect: CGRect) -> CGRect {
        guard rect.width > DictationConfig.caretMaxWidth else { return rect }
        return CGRect(x: rect.minX, y: rect.minY, width: 0, height: rect.height)
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
        if range.length == 0, let line = insertionLineRange(in: element, disagreeingWith: range.location) {
            Log.debug("CaretLocator: caret index \(range.location) is off the insertion line \(line.location)+\(line.length)")
            let lineEnd = line.location + line.length - 1
            // Past the end: a terminal cursor after trailing spaces, which the line's text drops.
            // The index still counts them, so step that many cells right of the line-break cell.
            if range.location > lineEnd,
               let breakCell = bounds(of: CFRange(location: lineEnd, length: 1), in: element) {
                return cellsRight(of: breakCell, by: range.location - lineEnd)
            }
            range.location = clamp(range.location, into: line)
        }

        Log.debug("CaretLocator: selected range \(range.location)+\(range.length)")
        // A collapsed caret sits at the leading edge of the character at its index (a newline
        // character at the end of a line included). Asked first because the empty range itself
        // is answered inconsistently: iTerm2 returns the cursor cell, nothing, or a box spanning
        // the cursor cell and the start of the next row, depending on how the line was drawn.
        if range.length == 0, let atCaret = bounds(of: CFRange(location: range.location, length: 1), in: element) {
            return CGRect(x: atCaret.minX, y: atCaret.minY, width: 0, height: atCaret.height)
        }
        if let caret = bounds(of: range, in: element) { return caret }
        // At the end of the text there is no character at the caret: use the trailing edge of the
        // one before it.
        guard range.location > 0,
              let previous = bounds(of: CFRange(location: range.location - 1, length: 1), in: element) else { return nil }
        return CGRect(x: previous.maxX, y: previous.minY, width: 0, height: previous.height)
    }

    /// The insertion line's character range, when the app reports a caret line that the caret's
    /// index doesn't fall on. iTerm2 counts the cursor's column from the line start including
    /// trailing spaces but drops those spaces from the line's text, so a cursor after typed spaces
    /// indexes a few characters into the next line; its insertion line number comes straight from
    /// the cursor. Apps that agree (or don't report a line) are left alone.
    private static func insertionLineRange(in element: AXUIElement, disagreeingWith index: Int) -> CFRange? {
        guard let line = attribute(element, kAXInsertionPointLineNumberAttribute) as? Int,
              let indexLine = parameterized(element, kAXLineForIndexParameterizedAttribute, index as CFNumber) as? Int,
              indexLine != line,
              let value = parameterized(element, kAXRangeForLineParameterizedAttribute, line as CFNumber),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.length > 0 else { return nil }
        return range
    }

    /// The caret `cells` monospace cells right of `cell`'s leading edge (terminal grids).
    static func cellsRight(of cell: CGRect, by cells: Int) -> CGRect {
        CGRect(x: cell.minX + CGFloat(cells) * cell.width, y: cell.minY, width: 0, height: cell.height)
    }

    /// The nearest index inside `line` (its last character is the line break, at the end of the
    /// line's text).
    static func clamp(_ index: Int, into line: CFRange) -> Int {
        min(max(index, line.location), line.location + line.length - 1)
    }

    private static func parameterized(_ element: AXUIElement, _ name: String, _ parameter: CFTypeRef) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, name as CFString, parameter, &value) == .success else { return nil }
        return value
    }

    /// The caret via the text-marker API (WebKit, Chromium/Electron): bounds of the selected
    /// text-marker range, which is the caret itself when the selection is collapsed.
    private static func markerCaretRect(in element: AXUIElement) -> CGRect? {
        guard let markerRange = attribute(element, "AXSelectedTextMarkerRange") else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element, "AXBoundsForTextMarkerRange" as CFString, markerRange, &value
        ) == .success, let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(value as! AXValue, .cgRect, &rect), rect.height > 0 else { return nil }
        return rect
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
