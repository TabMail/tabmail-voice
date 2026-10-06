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
    static func selection(selection: CFTypeRef, whole: CFTypeRef,
                          parameterized: (String, CFTypeRef) -> CFTypeRef?) -> (count: Int, range: NSRange)? {
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
        return (count, NSRange(location: min(anchor, focus), length: abs(focus - anchor)))
    }
}
