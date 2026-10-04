// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
}
