// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import VoiceHelperSupport

/// Finds where the text will land in the frontmost app, via Accessibility, so the dictation
/// overlay can appear there: the text cursor (caret) if the app exposes it, otherwise the focused
/// text field.
enum CaretLocator {
    /// The anchor's screen rect in Cocoa coordinates (bottom-left origin), or nil when the app
    /// exposes neither a caret nor a field-sized focused element (then the caller uses the mouse
    /// pointer). Blocking cross-process Accessibility calls, each bounded by
    /// `HelperConfig.caretLookupTimeout`: call off the main thread.
    static func anchorRect(inApp pid: pid_t) -> CGRect? {
        // Ask the frontmost app itself: the system-wide focused element is unreliable in some
        // apps (it can fail or lag behind the app's own focus).
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, HelperConfig.caretLookupTimeout)
        guard let focused = attribute(app, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            HelperLog.debug("CaretLocator: no focused element")
            return nil
        }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, HelperConfig.caretLookupTimeout)
        HelperLog.debug("CaretLocator: app \(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "?")")
        let screens = NSScreen.screens.map(\.frame)
        guard let primaryHeight = screens.first?.height else { return nil }

        // Text markers first: Chromium/Electron and WebKit keep them current as the caret moves,
        // while their index-based range answers can go stale or empty after typing.
        for (source, caret) in [("text marker", markerCaretRect(in: element)), ("text range", caretRect(in: element))] {
            guard let caret else {
                HelperLog.debug("CaretLocator: \(source): none")
                continue
            }
            let rect = caretEdge(of: cocoaRect(fromAccessibility: caret, primaryScreenHeight: primaryHeight))
            HelperLog.debug("CaretLocator: \(source): \(caret) (screen \(rect))")
            if isPlausible(rect, screens: screens) { return rect }
            HelperLog.debug("CaretLocator: \(source): ignoring an implausible rect")
        }
        if let frame = frame(of: element) {
            let rect = cocoaRect(fromAccessibility: frame, primaryScreenHeight: primaryHeight)
            // At its leading edge, where the caret of an empty field is (Chromium gives an empty
            // search, To or Subject field no caret box), not mid-field.
            if rect.height <= HelperConfig.focusedElementMaxAnchorHeight, isPlausible(rect, screens: screens) {
                HelperLog.debug("CaretLocator: no caret; anchoring to the focused field's leading edge \(frame)")
                return caretEdge(of: rect)
            }
        }
        HelperLog.debug("CaretLocator: no caret or field-sized focused element")
        return nil
    }

    /// Some apps answer a caret query with a whole line's box instead of a caret: Chromium at the
    /// very start of a field (e.g. over its placeholder), terminals at a wrapped line. The caret is
    /// at that box's leading edge; centering on the box would put the overlay mid-line.
    static func caretEdge(of rect: CGRect) -> CGRect {
        guard rect.width > HelperConfig.caretMaxWidth else { return rect }
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
            HelperLog.debug("CaretLocator: caret index \(range.location) is off the insertion line \(line.location)+\(line.length)")
            let lineEnd = line.location + line.length - 1
            // Past the end: a terminal cursor after trailing spaces, which the line's text drops.
            // The index still counts them, so step that many cells right of the line-break cell.
            if range.location > lineEnd,
               let breakCell = bounds(of: CFRange(location: lineEnd, length: 1), in: element) {
                return cellsRight(of: breakCell, by: range.location - lineEnd)
            }
            range.location = clamp(range.location, into: line)
        }

        HelperLog.debug("CaretLocator: selected range \(range.location)+\(range.length)")
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

    static func parameterized(_ element: AXUIElement, _ name: String, _ parameter: CFTypeRef) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, name as CFString, parameter, &value) == .success else { return nil }
        return value
    }

    /// The caret via the text-marker API (WebKit, Chromium/Electron): bounds of the selected
    /// text-marker range, which is the caret itself when the selection is collapsed.
    private static func markerCaretRect(in element: AXUIElement) -> CGRect? {
        guard let markerRange = attribute(element, "AXSelectedTextMarkerRange"),
              CFGetTypeID(markerRange) == AXTextMarkerRangeGetTypeID(),
              let box = markerBounds(markerRange, in: element) else { return nil }
        guard box.width > HelperConfig.caretMaxWidth,
              (parameterized(element, "AXLengthForTextMarkerRange", markerRange) as? NSNumber)?.intValue == 0 else { return box }
        let caret = AXTextMarkerRangeCopyStartMarker(markerRange as! AXTextMarkerRange)
        if let block = blockText(of: caret, in: element),
           let rect = caretLine(in: box, before: block.before, text: block.text, textHeights: block.textHeights) {
            return rect
        }
        guard let line = (parameterized(element, "AXLineForTextMarker", caret) as? NSNumber)?.intValue,
              let text = textLines(in: element) else { return box }
        return caretLine(in: box, line: line, text: text)
    }

    /// The text of the block a caret is in, when that block is not the whole field (a rich-text
    /// paragraph, Gmail's signature): its text before the caret and all of it, and its pieces'
    /// heights. Chromium numbers a rich editor's lines without the break each paragraph starts
    /// with, so a caret at a block's start is given the line of the text above it; the block
    /// itself, which is what Chromium gives the caret's box of, is right.
    private static func blockText(of caret: AXTextMarker, in element: AXUIElement) -> (before: String, text: String, textHeights: [CGFloat])? {
        guard let value = parameterized(element, "AXUIElementForTextMarker", caret), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        let block = value as! AXUIElement
        guard !CFEqual(block, element),
              let whole = parameterized(element, "AXTextMarkerRangeForUIElement", block), CFGetTypeID(whole) == AXTextMarkerRangeGetTypeID(),
              let text = parameterized(element, "AXStringForTextMarkerRange", whole) as? String,
              let start = parameterized(element, "AXTextMarkerRangeForUnorderedTextMarkers",
                                        [AXTextMarkerRangeCopyStartMarker(whole as! AXTextMarkerRange), caret] as CFArray),
              let before = parameterized(element, "AXStringForTextMarkerRange", start) as? String else { return nil }
        let heights = ((attribute(block, kAXChildrenAttribute) as? [AXUIElement]) ?? []).compactMap(frame(of:)).map(\.height).filter { $0 > 0 }
        return (before, text, heights)
    }

    /// A caret on an empty line of a block that holds several lines (Chromium gives a line break
    /// no box of its own, only its block's): the line is the one after as many breaks as the
    /// block's text has before the caret, and the block's lines share its height (a last break
    /// adds no line). A block whose text wraps (a piece taller than the others' one line) has
    /// more lines than breaks, so it is not measured this way.
    static func caretLine(in box: CGRect, before: String, text: String, textHeights: [CGFloat]) -> CGRect? {
        let breaks = text.filter(\.isNewline).count
        let lines = breaks + (text.last?.isNewline == true ? 0 : 1)
        if let lowest = textHeights.min(), textHeights.contains(where: { $0 > lowest * 1.5 }) { return nil }
        guard !text.isEmpty, before.count <= text.count else { return nil }
        let height = box.height / CGFloat(lines)
        let line = before.filter(\.isNewline).count
        let caret = CGRect(x: box.minX, y: box.minY + CGFloat(line) * height, width: 0, height: height)
        HelperLog.debug("CaretLocator: caret box \(box) is a block of \(lines) lines; the caret is on its line \(line), \(caret)")
        return caret
    }

    /// Where the field's text is: the frames of its pieces (Chromium gives each run of text one,
    /// even where it gives no character a box), and the first and last lines that hold more than
    /// a line break.
    private static func textLines(in element: AXUIElement) -> TextLines? {
        let frames = ((attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []).compactMap(frame(of:)).filter { $0.height > 0 }
        guard let top = frames.min(by: { $0.minY < $1.minY }), let bottom = frames.map(\.maxY).max(),
              let count = (attribute(element, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue, count > 0,
              let last = (parameterized(element, kAXLineForIndexParameterizedAttribute, (count - 1) as CFNumber) as? NSNumber)?.intValue,
              last >= 0 else { return nil }
        func holdsText(_ line: Int) -> Bool {
            guard let value = parameterized(element, kAXRangeForLineParameterizedAttribute, line as CFNumber),
                  CFGetTypeID(value) == AXValueGetTypeID() else { return false }
            var range = CFRange()
            return AXValueGetValue(value as! AXValue, .cfRange, &range) && range.length > 1
        }
        guard let firstLine = (0 ... last).first(where: holdsText),
              let lastLine = (firstLine ... last).reversed().first(where: holdsText) else { return nil }
        return TextLines(top: top.minY, bottom: bottom, lineHeight: top.height, firstLine: firstLine, lastLine: lastLine)
    }

    struct TextLines: Equatable {
        /// The top of the first line's text and the bottom of the last's.
        let top, bottom: CGFloat
        /// One line's text height.
        let lineHeight: CGFloat
        let firstLine, lastLine: Int
    }

    /// An empty line holds only a line break, which Chromium draws no text box for: a caret there
    /// gets the box of the block that holds the line (in a plain-text Gmail message the whole
    /// field, in a rich-text one sometimes several paragraphs), and nothing gives its own place
    /// but its line number. The caret is put on that line, measured from the field's text: its
    /// lines are as far apart as its first and last lines of text say. A box no taller than one
    /// such line is the caret's line; a field with one line of text says nothing of the spacing.
    static func caretLine(in box: CGRect, line: Int, text: TextLines) -> CGRect {
        guard line >= 0, text.lastLine > text.firstLine, text.lineHeight > 0 else { return box }
        let spacing = (text.bottom - text.top - text.lineHeight) / CGFloat(text.lastLine - text.firstLine)
        guard spacing > 0, box.height > spacing else { return box }
        let caret = CGRect(x: box.minX, y: text.top + CGFloat(line - text.firstLine) * spacing, width: 0, height: text.lineHeight)
        HelperLog.debug("CaretLocator: caret box \(box) spans lines; line \(line) with text on lines \(text.firstLine)-\(text.lastLine) at \(text.top)-\(text.bottom) is \(caret)")
        return caret
    }

    private static func markerBounds(_ markerRange: CFTypeRef, in element: AXUIElement) -> CGRect? {
        guard let value = parameterized(element, "AXBoundsForTextMarkerRange", markerRange),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(value as! AXValue, .cgRect, &rect), rect.height > 0 else { return nil }
        return rect
    }

    static func frame(of element: AXUIElement) -> CGRect? {
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

    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func bounds(of range: CFRange, in element: AXUIElement) -> CGRect? {
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
