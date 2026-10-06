// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import ApplicationServices
import Foundation

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
        let unavailable = SharedContext.CaretWindow(parts: ["", Redactor.placeholder, ""], selectionUnavailable: true)
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
            guard let final = snapshot(), endpoints(final) == positions,
                  CFEqual(initial.selection, final.selection), CFEqual(initial.whole, final.whole), focused() else { return unavailable }
            return result
        } catch { return unavailable }
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

    /// Where Chromium starts each paragraph from `units` before the selection (`range`, as
    /// `selection` counted it) to `units` after it, ascending: its text leaves out the break
    /// before a paragraph that starts right after text (each <div> of a rich editor), and the
    /// shared core puts those back (ADR-DESK-007, 2026-10-06). Its paragraphs
    /// (`AXParagraphTextMarkerRangeForTextMarker`) are walked back from the selection and on from
    /// it, each start counted from the last place by the length between them, never from the
    /// field's start. Nil when a length can't be had; the walk ends where the markers do.
    static func paragraphStarts(selection: CFTypeRef, whole: CFTypeRef, range: NSRange, within units: Int,
                                parameterized: (String, CFTypeRef) -> CFTypeRef?) -> [Int]? {
        guard CFGetTypeID(selection) == AXTextMarkerRangeGetTypeID(), CFGetTypeID(whole) == AXTextMarkerRangeGetTypeID(), units >= 0 else { return nil }
        func length(_ from: CFTypeRef, _ to: CFTypeRef) -> Int? {
            guard let range = parameterized("AXTextMarkerRangeForUnorderedTextMarkers", [from, to] as CFArray),
                  let value = parameterized("AXLengthForTextMarkerRange", range) as? NSNumber, value.intValue >= 0 else { return nil }
            return value.intValue
        }
        func paragraph(_ marker: CFTypeRef) -> (start: AXTextMarker, end: AXTextMarker)? {
            guard let value = parameterized("AXParagraphTextMarkerRangeForTextMarker", marker),
                  CFGetTypeID(value) == AXTextMarkerRangeGetTypeID() else { return nil }
            return (AXTextMarkerRangeCopyStartMarker(value as! AXTextMarkerRange), AXTextMarkerRangeCopyEndMarker(value as! AXTextMarkerRange))
        }
        func step(_ name: String, _ marker: CFTypeRef) -> CFTypeRef? {
            guard let value = parameterized(name, marker), CFGetTypeID(value) == AXTextMarkerGetTypeID(), !CFEqual(value, marker) else { return nil }
            return value
        }
        let ends = [AXTextMarkerRangeCopyStartMarker(selection as! AXTextMarkerRange), AXTextMarkerRangeCopyEndMarker(selection as! AXTextMarkerRange)]
        let fieldStart = AXTextMarkerRangeCopyStartMarker(whole as! AXTextMarkerRange)
        guard let anchor = length(fieldStart, ends[0]) else { return nil }
        let first: CFTypeRef = anchor == range.location ? ends[0] : ends[1]
        // Every paragraph holds a character or none, so a walk past this many has stopped moving.
        let steps = 2 * units + range.length + 2
        var starts = Set<Int>()
        // Back: the paragraph holding the marker, then the one holding the marker before its start.
        var marker = first, offset = range.location
        for _ in 0 ..< steps {
            guard let held = paragraph(marker), let back = length(held.start, marker) else { break }
            let start = offset - back
            guard start >= range.location - units, start >= 0 else { break }
            starts.insert(start)
            guard let previous = step("AXPreviousTextMarkerForTextMarker", held.start), let gap = length(previous, held.start) else { break }
            (marker, offset) = (previous, start - gap)
        }
        // On: past the end of the paragraph holding the marker, to the next paragraph's start.
        let last = range.location + range.length
        (marker, offset) = (first, range.location)
        for _ in 0 ..< steps {
            guard let held = paragraph(marker), let ahead = length(marker, held.end),
                  let next = step("AXNextTextMarkerForTextMarker", held.end), let gap = length(held.end, next),
                  let following = paragraph(next), !CFEqual(following.start, held.start), let into = length(following.start, next) else { break }
            let start = offset + ahead + gap - into
            guard start <= last + units else { break }
            starts.insert(start)
            (marker, offset) = (next, offset + ahead + gap)
        }
        return starts.sorted()
    }
}
