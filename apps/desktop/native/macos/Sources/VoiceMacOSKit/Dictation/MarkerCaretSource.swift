// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import ApplicationServices
import Foundation
import VoiceHelperSupport

/// Converts opaque provider markers to bounded native ranges. Marker indices can be
/// document-relative, so the focused element's start is retained as an explicit origin.
enum MarkerCaretSource {
    static func read(snapshot: () -> (selection: CFTypeRef, whole: CFTypeRef)?,
                     parameterized: (String, CFTypeRef) -> CFTypeRef?, focused: () -> Bool) -> SharedContext.CaretWindow? {
        func index(_ marker: CFTypeRef) -> Int? {
            guard let result = parameterized("AXIndexForTextMarker", marker) as? NSNumber else { return nil }
            let value = result.intValue
            return value >= 0 && value != NSNotFound ? value : nil
        }
        func endpoints(_ state: (selection: CFTypeRef, whole: CFTypeRef)) -> [Int]? {
            let ranges = [state.whole, state.selection]
            var result: [Int] = []
            for range in ranges {
                for name in ["AXStartTextMarkerForTextMarkerRange", "AXEndTextMarkerForTextMarkerRange"] {
                    guard let marker = parameterized(name, range), let offset = index(marker) else { return nil }
                    result.append(offset)
                }
            }
            guard result[0] <= result[2], result[2] <= result[3], result[3] <= result[1] else { return nil }
            return result
        }
        guard let initial = snapshot(), let positions = endpoints(initial) else { return nil }
        HelperLog.debug("ScreenContext: caret \(positions[2] - positions[0])+\(positions[3] - positions[2]) of \(positions[1] - positions[0]) chars, from the marker indices")
        guard let unavailable = try? SharedContext.CaretWindow.unread(selectsText: positions[3] > positions[2]) else { return nil }
        do {
            let origin = positions[0]
            let result = try BoundedCaretSource.read(count: positions[1] - origin,
                selection: NSRange(location: positions[2] - origin, length: positions[3] - positions[2])) { requested in
                let start = origin + requested.location
                let end = start + requested.length
                guard let first = parameterized("AXTextMarkerForIndex", NSNumber(value: start)),
                      let last = parameterized("AXTextMarkerForIndex", NSNumber(value: end)),
                      index(first) == start, index(last) == end,
                      let range = parameterized("AXTextMarkerRangeForUnorderedTextMarkers", [first, last] as CFArray) else { return nil }
                return parameterized("AXStringForTextMarkerRange", range) as? NSString
            }
            let final = snapshot()
            let finalPositions = final.flatMap(endpoints)
            let isFocused = focused()
            guard let final, finalPositions == positions,
                  CFEqual(initial.selection, final.selection), CFEqual(initial.whole, final.whole), isFocused else {
                HelperLog.debug("ScreenContext: the field changed while it was read (now \(finalPositions.map { "\($0[2] - $0[0])+\($0[3] - $0[2]) of \($0[1] - $0[0])" } ?? "unreadable"), focused \(isFocused)); selection \(unavailable.selectionUnavailable ? "unavailable" : "empty, its text unread")")
                return unavailable
            }
            return result
        } catch {
            HelperLog.debug("ScreenContext: the field's text could not be read around the caret by its markers; selection \(unavailable.selectionUnavailable ? "unavailable" : "empty, its text unread")")
            return unavailable
        }
    }

    /// The field's length and its selection, counted in its text markers: the length of the text
    /// from the field's start to each end. Chromium gives a field no marker-index conversion (no
    /// `AXStartTextMarkerForTextMarkerRange` or `AXEndTextMarkerForTextMarkerRange`), so `read` gives
    /// up there, and its character range (`AXSelectedTextRange`) puts a caret on an empty line at the
    /// start of the paragraph above it, while its markers are right (Gmail, 2026-10-05). Its value
    /// (`AXNumberOfCharacters`) can hold a paragraph break its markers and string ranges
    /// (`AXStringForRange`) leave out, so the field is counted in the markers too: a range read
    /// near the end then stays inside the text the ranges hold.
    /// A selection made backward has its markers in the order it was made (Chromium's anchor, then
    /// focus), so the earlier one starts it.
    /// `startsParagraph`: whether the paragraph holding that start begins there
    /// (`AXParagraphTextMarkerRangeForTextMarker`), nil when not told. An empty line is a paragraph
    /// of its own whose break the string ranges leave out, so the shared core puts it back before
    /// the caret (ADR-DESK-007, 2026-10-06).
    static func selection(selection: CFTypeRef, whole: CFTypeRef,
                          parameterized: (String, CFTypeRef) -> CFTypeRef?) -> (count: Int, range: NSRange, startsParagraph: Bool?)? {
        guard CFGetTypeID(selection) == AXTextMarkerRangeGetTypeID(), CFGetTypeID(whole) == AXTextMarkerRangeGetTypeID() else { return nil }
        func length(_ range: CFTypeRef?) -> Int? {
            guard let range, let value = parameterized("AXLengthForTextMarkerRange", range) as? NSNumber, value.intValue >= 0 else { return nil }
            return value.intValue
        }
        let fieldStart = AXTextMarkerRangeCopyStartMarker(whole as! AXTextMarkerRange)
        func offset(_ marker: AXTextMarker) -> Int? {
            length(parameterized("AXTextMarkerRangeForUnorderedTextMarkers", [fieldStart, marker] as CFArray))
        }
        let ends = [AXTextMarkerRangeCopyStartMarker(selection as! AXTextMarkerRange), AXTextMarkerRangeCopyEndMarker(selection as! AXTextMarkerRange)]
        guard let count = length(whole), let anchor = offset(ends[0]), let focus = offset(ends[1]), max(anchor, focus) <= count else { return nil }
        let start = min(anchor, focus)
        let startsParagraph = parameterized("AXParagraphTextMarkerRangeForTextMarker", ends[anchor <= focus ? 0 : 1]).flatMap { paragraph in
            CFGetTypeID(paragraph) == AXTextMarkerRangeGetTypeID() ? offset(AXTextMarkerRangeCopyStartMarker(paragraph as! AXTextMarkerRange)) : nil
        }.map { $0 == start }
        return (count, NSRange(location: start, length: abs(focus - anchor)), startsParagraph)
    }

    /// Where a Chromium rich editor starts its blocks from `units` before the selection to `units`
    /// after it, ascending: its text leaves out the break before a block that starts right after
    /// text (each <div>), and the shared core puts those back where the text has none
    /// (ADR-DESK-007, 2026-10-06). A block is an element `isBlock` says is one (a <div> is a
    /// group; inline formatting and links are not), and text after a block starts a line too.
    /// `span` is an element's place in the field's text. Chromium's own paragraph answers can't be
    /// used: walked from a break they give each run of text (a word edited apart) as a paragraph.
    /// Siblings are searched by halves for the first that reaches the window, so a long field costs
    /// a few looks. Nil when an element has no place, or past `elements` looks.
    static func blockStarts<Node>(in field: Node, around range: NSRange, within units: Int, elements: Int,
                                  children: (Node) -> [Node], isBlock: (Node) -> Bool, span: (Node) -> NSRange?) -> [Int]? {
        let low = range.location - units, high = NSMaxRange(range) + units
        var starts = Set<Int>(), looks = 0
        func place(_ node: Node) -> NSRange? {
            looks += 1
            return looks <= elements ? span(node) : nil
        }
        func walk(_ node: Node) -> Bool {
            let nodes = children(node)
            // The first child that ends at or after the window's start.
            var lower = 0, upper = nodes.count
            while lower < upper {
                let middle = (lower + upper) / 2
                guard let span = place(nodes[middle]) else { return false }
                if NSMaxRange(span) < low { lower = middle + 1 } else { upper = middle }
            }
            var afterBlock = lower > 0 && isBlock(nodes[lower - 1])
            for node in nodes[lower...] {
                guard let span = place(node) else { return false }
                if span.location > high { break }
                let block = isBlock(node)
                if block || afterBlock, span.location >= low { starts.insert(span.location) }
                if block, !walk(node) { return false }
                afterBlock = block
            }
            return true
        }
        return walk(field) ? starts.sorted() : nil
    }

    /// Whether a selection starting at `location` is at the end of the line above a block that
    /// starts there, not at that block's start: the text gives both places one offset, and
    /// Chromium tells them apart by the element its start marker is in (`span`, its place in the
    /// field's text), the line's text or block ending there or the block starting there (measured
    /// 2026-10-06). The shared core then puts that block's break after the caret.
    static func endsLine(caretElement span: NSRange?, at location: Int) -> Bool {
        guard let span else { return false }
        return span.location < location && NSMaxRange(span) >= location
    }
}
