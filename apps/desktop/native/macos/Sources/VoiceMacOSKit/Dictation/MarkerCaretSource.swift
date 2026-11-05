// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import ApplicationServices
import Foundation
import VoiceHelperSupport

/// Converts opaque provider markers to bounded native ranges. Marker indices can be
/// document-relative, so the focused element's start is retained as an explicit origin.
enum MarkerCaretSource {
    /// A field's elements, for the breaks its text leaves out where a block starts. Gecko's text
    /// joins two lines that are each a block (a rich editor's element per line: Overleaf's code
    /// editor in Firefox, 2026-11-04) and gives a break only for an empty line, so a caret starting
    /// a line read as right after the line above, and a dictation there was spaced from its "."
    /// (issue #339). The shared core puts those breaks back, as it does for Chromium's (`blockStarts`,
    /// ADR-DESK-007).
    struct Blocks {
        let field: AnyObject
        let children: (AnyObject) -> [AnyObject]
        let isBlock: (AnyObject) -> Bool
        /// The marker range an element covers (`AXTextMarkerRangeForUIElement`).
        let range: (AnyObject) -> CFTypeRef?
        /// The element a marker is in (`AXUIElementForTextMarker`), nil for the field itself.
        let element: (CFTypeRef) -> AnyObject?
    }

    /// The text around the caret, read by its markers. Where the markers place the caret but give no
    /// text around it (Firefox's address bar: its value and selected range read fine), the field is
    /// read as `otherwise` reads it, and is unread only when that gives nothing either; a field that
    /// changed while it was read is unread.
    /// `blocks`: the field's elements, placed by their markers' indices, so the shared core puts
    /// back the break the text leaves out at each block start near the caret.
    static func read(snapshot: () -> (selection: CFTypeRef, whole: CFTypeRef)?,
                     parameterized: (String, CFTypeRef) -> CFTypeRef?, focused: () -> Bool,
                     blocks: Blocks? = nil,
                     otherwise: () -> SharedContext.CaretWindow?) -> SharedContext.CaretWindow? {
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
        let origin = positions[0]
        let selection = NSRange(location: positions[2] - origin, length: positions[3] - positions[2])
        let layout = blocks.flatMap { blocks -> (starts: [Int], caretEndsLine: Bool)? in
            let looked = Date()
            guard let limits = try? SharedContext.sourceLimits() else { return nil }
            func span(_ node: AnyObject) -> NSRange? {
                guard let whole = blocks.range(node),
                      let first = parameterized("AXStartTextMarkerForTextMarkerRange", whole).flatMap(index),
                      let last = parameterized("AXEndTextMarkerForTextMarkerRange", whole).flatMap(index),
                      first >= origin, last >= first else { return nil }
                return NSRange(location: first - origin, length: last - first)
            }
            let starts = blockStarts(in: blocks.field, around: selection, within: limits.paragraphStartUnits,
                                     elements: limits.caretSourceElements, children: blocks.children, isBlock: blocks.isBlock, span: span)
            // The element the caret is in, to tell the end of a line from the start of the block after it.
            let caretElement = parameterized("AXStartTextMarkerForTextMarkerRange", initial.selection)
                .flatMap(blocks.element).flatMap(span)
            let ends = endsLine(caretElement: caretElement, at: selection.location)
            HelperLog.debug("ScreenContext: \(starts.map { "\($0.count)" } ?? "no") block starts near the caret in \(Int(Date().timeIntervalSince(looked) * 1000)) ms; the caret \(ends ? "ends a line" : "starts its text")")
            return starts.map { (starts: $0, caretEndsLine: ends) }
        }
        do {
            let result = try BoundedCaretSource.read(count: positions[1] - origin, selection: selection,
                                                     paragraphStarts: layout?.starts, caretEndsLine: layout?.caretEndsLine ?? false) { requested in
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
            HelperLog.debug("ScreenContext: the field's text could not be read around the caret by its markers; read by its value")
            if let window = otherwise() { return window }
            HelperLog.debug("ScreenContext: nor by its value; selection \(unavailable.selectionUnavailable ? "unavailable" : "empty, its text unread")")
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
    /// (ADR-DESK-007, 2026-10-06). The core walks the field (`blockStarts`, ADR-DESK-054): which
    /// element to place, which start a line, and when the walk ends; this says what AX gives.
    /// A block is an element `isBlock` says is one (a <div> is a group; inline formatting and links
    /// are not). `span` is an element's place in the field's text. Chromium's own paragraph answers
    /// can't be used: walked from a break they give each run of text (a word edited apart) as a
    /// paragraph. Nil when an element has no place, or past `elements` looks.
    static func blockStarts<Node>(in field: Node, around range: NSRange, within units: Int, elements: Int,
                                  children: (Node) -> [Node], isBlock: (Node) -> Bool, span: (Node) -> NSRange?) -> [Int]? {
        let low = range.location - units, high = NSMaxRange(range) + units
        // The children of each element the walk is in, the field's first.
        var path: [[Node]] = []
        var starts = Set<Int>(), placed: Int?
        func node(_ asked: [String: Any]) -> Node? {
            guard let depth = asked["depth"] as? Int, let child = asked["child"] as? Int,
                  depth >= 0, depth < path.count, child >= 0, child < path[depth].count else { return nil }
            path.removeSubrange((depth + 1)...)
            return path[depth][child]
        }
        var reply = blocks(["start": ["elements": elements]])
        while let current = reply {
            if current["start"] as? Bool == true, let placed { starts.insert(placed) }
            if let done = current["done"] as? Bool { return done ? starts.sorted() : nil }
            guard let state = current["state"], let asked = current["ask"] as? [String: Any] else { return nil }
            if let wanted = asked["children"] as? [String: Any] {
                let parent: Node
                if wanted["depth"] is NSNull {
                    path = []
                    parent = field
                } else {
                    guard let found = node(wanted) else { return nil }
                    parent = found
                }
                let nodes = children(parent)
                path.append(nodes)
                reply = blocks(["state": state, "children": nodes.count])
            } else if let wanted = asked["place"] as? [String: Any], let element = node(wanted) {
                guard let place = span(element) else {
                    reply = blocks(["state": state, "placed": NSNull()])
                    continue
                }
                placed = place.location
                let facts: [String: Any] = wanted["phase"] as? String == "halve"
                    ? ["block": isBlock(element), "endsBefore": NSMaxRange(place) < low]
                    : ["block": isBlock(element), "startsPast": place.location > high, "startsWithin": place.location >= low]
                reply = blocks(["state": state, "placed": facts])
            } else {
                return nil
            }
        }
        return nil
    }

    /// Whether a selection starting at `location` is at the end of the line above a block that
    /// starts there, not at that block's start: the text gives both places one offset, and
    /// Chromium tells them apart by the element its start marker is in (`span`, its place in the
    /// field's text), the line's text or block ending there or the block starting there (measured
    /// 2026-10-06). The shared core decides; it then puts that block's break after the caret.
    static func endsLine(caretElement span: NSRange?, at location: Int) -> Bool {
        guard let span else { return false }
        let reply = blocks(["endsLine": ["startsBefore": span.location < location, "reachesSelection": NSMaxRange(span) >= location]])
        return reply?["endsLine"] as? Bool ?? false
    }

    /// One step of the core's block walk (`blockStarts`); nil when the core refuses it.
    private static func blocks(_ request: [String: Any]) -> [String: Any]? {
        guard let input = try? JSONSerialization.data(withJSONObject: ["blockStarts": request]),
              let output = try? Redactor.request(input, operation: .context) else { return nil }
        return (try? JSONSerialization.jsonObject(with: output)) as? [String: Any]
    }
}
