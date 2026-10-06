// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation
import Testing
@testable import VoiceMacOSKit

struct BoundedFieldReaderTests {
    @Test func wholeValueOnlyProviderRemainsSupported() throws {
        var calls = 0
        let result = try BoundedFieldReader.read(count: nil, whole: {
            calls += 1; return "Read-only 😀 field" as NSString
        }, range: nil, visible: { _ in Issue.record("small field should not request visibility"); return nil }, valid: { true })
        #expect(calls == 1)
        #expect(result?.parts == ["", "Read-only 😀 field", ""])
    }
    @Test func largeKnownCountSkipsWholeProbeAndKeepsRecognitionContext() throws {
        let prefix = String(repeating: "x", count: 300000) + ". password: "
        let visible = "syntheticSecret123"
        let text = (prefix + visible + ". After") as NSString
        let interval = NSRange(location: (prefix as NSString).length, length: (visible as NSString).length)
        var firstRead: NSRange?
        let result = try #require(try BoundedFieldReader.read(count: text.length, whole: {
            Issue.record("range provider should not acquire whole value"); return nil
        }, range: { requested in
            if firstRead == nil { firstRead = requested }
            return text.substring(with: requested) as NSString
        }, visible: { _ in interval }, valid: { true }))
        #expect(firstRead?.location == interval.location)
        #expect(result.parts[1] == visible)
        var context = ScreenContext(appName: "Synthetic", bundleID: nil, windowTitle: nil)
        context.appendField(result.parts)
        #expect(try context.renderedText() == "> [redacted]")
    }
    @Test func longWholeSnapshotReusesItsNativeStorageForVisibleSource() throws {
        let prefix = String(repeating: "x", count: 300000) + ". Before "
        let text = (prefix + "Visible 😀" + ". After") as NSString
        var wholeReads = 0
        let result = try BoundedFieldReader.read(count: nil, whole: { wholeReads += 1; return text }, range: nil,
            visible: { count in
                #expect(count == text.length)
                return NSRange(location: (prefix as NSString).length, length: ("Visible 😀" as NSString).length)
            }, valid: { true })
        #expect(wholeReads == 1)
        #expect(result?.parts[1] == "Visible 😀")
    }
    @Test func wholeEligibilityUsesSharedGraphemesRatherThanUTF16Units() throws {
        let value = String(repeating: "😀", count: 15000) as NSString
        let result = try BoundedFieldReader.read(count: value.length, whole: { nil }, range: { value.substring(with: $0) as NSString },
            visible: { _ in Issue.record("15000 graphemes fit whole-field policy"); return nil }, valid: { true })
        #expect(result?.parts[1] == value as String)
    }
    @Test func malformedRangeDoesNotFallBackToWholeValue() throws {
        var wholeReads = 0
        #expect(throws: (any Error).self) {
            try BoundedFieldReader.read(count: 10, whole: { wholeReads += 1; return "fallback" as NSString },
                range: { _ in "short" as NSString }, visible: { _ in nil }, valid: { true })
        }
        #expect(wholeReads == 0)
    }
    @Test func invalidationDiscardsTheField() throws {
        var valid = true
        #expect(throws: (any Error).self) {
            try BoundedFieldReader.read(count: 5, whole: { nil }, range: { _ in valid = false; return "field" as NSString },
                visible: { _ in nil }, valid: { valid })
        }
    }
}
