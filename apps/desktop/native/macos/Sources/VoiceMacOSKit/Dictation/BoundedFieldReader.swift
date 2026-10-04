// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation

/// Native capability dispatch. Rust owns whole/visible eligibility, requested
/// spans, budgets and recognition boundaries; callers retain the three parts.
enum BoundedFieldReader {
    static func read(count initialCount: Int?, whole: () -> NSString?,
                     range: ((NSRange) -> NSString?)?, visible: (Int) -> NSRange?,
                     valid: () -> Bool) throws -> BoundedCaretSource.Projection? {
        guard initialCount == nil || initialCount! >= 0, valid() else { throw Redactor.Failure.refused }
        let count: Int
        let read: (NSRange) -> NSString?
        if let initialCount, let range {
            count = initialCount
            read = range
        } else {
            // AXValue has no size-limited variant. Keep one native snapshot for
            // value-only providers; never claim this bounds its receipt allocation.
            guard let snapshot = whole(), valid(), initialCount == nil || initialCount == snapshot.length else { throw Redactor.Failure.refused }
            count = snapshot.length
            read = { requested in
                guard requested.location >= 0, requested.length >= 0,
                      requested.location <= snapshot.length, requested.length <= snapshot.length - requested.location else { return nil }
                return snapshot.substring(with: requested) as NSString
            }
        }
        let checkedRead: (NSRange) -> NSString? = { requested in
            guard valid(), let value = read(requested), valid() else { return nil }
            return value
        }
        if try SharedContext.fieldPlan(count: count).probeWhole {
            let result = try BoundedCaretSource.field(count: count, interval: NSRange(location: 0, length: count), range: checkedRead)
            if result.complete, try SharedContext.fieldPlan(count: count, text: result.text).useWhole {
                guard valid() else { throw Redactor.Failure.refused }
                return BoundedCaretSource.Projection(parts: ["", result.text, ""], complete: true)
            }
        }
        guard valid(), let interval = visible(count), valid() else { return nil }
        let result = try BoundedCaretSource.visibleField(count: count, interval: interval, range: checkedRead)
        guard valid() else { throw Redactor.Failure.refused }
        return result
    }
}
