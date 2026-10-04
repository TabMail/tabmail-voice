// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation
import Testing
@testable import VoiceMacOSKit

struct MarkerCaretSourceTests {
    @Test func documentRelativeMarkersPreserveTheFocusedField() throws {
        let selected = String(repeating: "😀é", count: 7000)
        let provider = Provider(text: "Before " + selected + " after", selection: NSRange(location: 7, length: (selected as NSString).length))
        let result = try #require(provider.read())
        #expect(result.parts == ["Before ", selected, " after"])
        #expect(!result.selectionUnavailable)
        #expect(provider.requests.allSatisfy { $0.location >= provider.origin && $0.length <= 4096 })
    }

    @Test func longFieldUsesBoundedWindowsAroundACompleteSelection() throws {
        let prefix = String(repeating: "a", count: 300000) + ". Before "
        let selected = String(repeating: "s", count: 20001)
        let provider = Provider(text: prefix + selected + " after! " + String(repeating: "b", count: 300000), selection: NSRange(location: prefix.utf16.count, length: selected.utf16.count))
        let result = try #require(provider.read())
        #expect(result.parts[1] == selected)
        #expect(!result.selectionUnavailable)
        #expect(provider.requests.allSatisfy { $0.length <= 4096 })
        #expect(provider.requests.reduce(0) { $0 + $1.length } < provider.text.length)
    }

    @Test func mismatchedMarkerRoundTripRefusesBeforeReadingText() throws {
        let provider = Provider(text: "before chosen after", selection: NSRange(location: 7, length: 6))
        provider.wrongMarker = true
        let result = try #require(provider.read())
        #expect(result.selectionUnavailable)
        #expect(provider.requests.isEmpty)
    }

    @Test func selectionChangingDuringAcquisitionIsUnavailable() throws {
        let provider = Provider(text: "before chosen after", selection: NSRange(location: 7, length: 6))
        provider.changeOnRead = true
        let result = try #require(provider.read())
        #expect(result.selectionUnavailable)
        #expect(result.parts == ["", Redactor.placeholder, ""])
    }

    private final class Provider {
        let origin = 12345
        let text: NSString
        var selection: NSRange
        var requests: [NSRange] = []
        var wrongMarker = false
        var changeOnRead = false
        init(text: String, selection: NSRange) { self.text = text as NSString; self.selection = selection }
        func read() -> SharedContext.CaretWindow? {
            MarkerCaretSource.read(snapshot: {
                (NSArray(array: [self.origin + self.selection.location, self.origin + self.selection.location + self.selection.length]),
                 NSArray(array: [self.origin, self.origin + self.text.length]))
            }, parameterized: { name, argument in
                switch name {
                case "AXStartTextMarkerForTextMarkerRange": return (argument as! NSArray)[0] as AnyObject
                case "AXEndTextMarkerForTextMarkerRange": return (argument as! NSArray)[1] as AnyObject
                case "AXIndexForTextMarker": return argument
                case "AXTextMarkerForIndex": return NSNumber(value: (argument as! NSNumber).intValue + (self.wrongMarker ? 1 : 0))
                case "AXTextMarkerRangeForUnorderedTextMarkers": return argument
                case "AXStringForTextMarkerRange":
                    let pair = argument as! NSArray
                    let start = (pair[0] as! NSNumber).intValue
                    let end = (pair[1] as! NSNumber).intValue
                    self.requests.append(NSRange(location: start, length: end - start))
                    if self.changeOnRead { self.selection.location += 1; self.changeOnRead = false }
                    guard start >= self.origin, end <= self.origin + self.text.length else { return nil }
                    return self.text.substring(with: NSRange(location: start - self.origin, length: end - start)) as NSString
                default: return nil
                }
            }, focused: { true })
        }
    }
}
