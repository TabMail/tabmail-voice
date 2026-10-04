// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation
import Testing
@testable import VoiceMacOSKit

struct BoundedCaretSourceTests {
    @Test func completeSelectionSurvivesUTF16ChunkBoundaries() throws {
        let selected = String(repeating: "a😀é", count: 7000)
        let source = ("Before " + selected + " after") as NSString
        let limits = try SharedContext.sourceLimits()
        var largest = 0
        let result = try BoundedCaretSource.read(count: source.length, selection: NSRange(location: 7, length: (selected as NSString).length)) {
            largest = max(largest, $0.length)
            return source.substring(with: $0) as NSString
        }
        #expect(result.parts == ["Before ", selected, " after"])
        #expect(!result.selectionUnavailable)
        #expect(largest <= limits.sourceChunkUnits)
    }

    @Test func exactUTF8BudgetCountsSurrogatePairsAcrossChunksOnce() throws {
        let selected = "a" + String(repeating: "😀", count: 65534) + "x"
        let source = selected as NSString
        let limits = try SharedContext.sourceLimits()
        #expect(selected.utf8.count == limits.selectionSourceBytes)
        let result = try BoundedCaretSource.read(count: source.length, selection: NSRange(location: 0, length: source.length)) {
            source.substring(with: $0) as NSString
        }
        #expect(!result.selectionUnavailable)
        #expect(result.parts == ["", selected, ""])
    }

    @Test func oversizedSelectionIsUnavailableRatherThanAPrefix() throws {
        let source = String(repeating: "😀", count: 65535) as NSString
        let result = try BoundedCaretSource.read(count: source.length, selection: NSRange(location: 0, length: source.length)) {
            source.substring(with: $0) as NSString
        }
        #expect(result.selectionUnavailable)
        #expect(result.parts == ["", Redactor.placeholder, ""])
    }

    @Test func shortProviderRangeIsRefused() throws {
        #expect(throws: (any Error).self) {
            try BoundedCaretSource.read(count: 10, selection: NSRange(location: 0, length: 10)) { _ in "short" as NSString }
        }
    }
    @Test func fieldTransportPreservesCompleteUnicodeAndBoundsVisibleRanges() throws {
        let text = "prefix unknown123. Visible 😀 sentence! unfinished456 suffix" as NSString
        let interval = NSRange(location: 7, length: text.length - 14)
        let result = try BoundedCaretSource.field(count: text.length, interval: interval) { requested in
            #expect(requested.location >= interval.location)
            #expect(NSMaxRange(requested) <= NSMaxRange(interval))
            return text.substring(with: requested) as NSString
        }
        #expect(result.complete)
        #expect(result.text == ". Visible 😀 sentence! ")
        let full = try BoundedCaretSource.field(count: text.length, interval: NSRange(location: 0, length: text.length)) {
            text.substring(with: $0) as NSString
        }
        #expect(full.complete && full.text == text as String)
    }
    @Test func oversizedFieldSignalsVisibleRangeFallbackWithoutOpenTail() throws {
        let text = ("Visible! " + String(repeating: "😀", count: 80000)) as NSString
        let result = try BoundedCaretSource.field(count: text.length, interval: NSRange(location: 0, length: text.length)) {
            text.substring(with: $0) as NSString
        }
        #expect(!result.complete)
        #expect(result.text == "Visible! ")
    }
    @Test func fieldTransportRejectsInvalidOrShortRanges() throws {
        #expect(throws: (any Error).self) {
            try BoundedCaretSource.field(count: 10, interval: NSRange(location: 0, length: 11)) { _ in "" as NSString }
        }
        #expect(throws: (any Error).self) {
            try BoundedCaretSource.field(count: 10, interval: NSRange(location: 0, length: 10)) { _ in "short" as NSString }
        }
    }

}
