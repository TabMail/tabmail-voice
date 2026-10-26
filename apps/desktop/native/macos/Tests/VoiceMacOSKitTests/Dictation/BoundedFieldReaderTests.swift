// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation
import Testing
@testable import VoiceMacOSKit

struct BoundedFieldReaderTests {
    @Test func wholeValueOnlyProviderRemainsSupported() throws {
        var calls = 0
        let result = try BoundedFieldReader.read(count: nil, wholeWindow: false, whole: {
            calls += 1; return "Read-only 😀 field" as NSString
        }, range: nil, visible: { _ in Issue.record("small field should not request visibility"); return nil }, valid: { true })
        #expect(calls == 1)
        #expect(result?.parts == ["", "Read-only 😀 field", ""])
    }
    @Test(arguments: [false, true]) func largeKnownCountSkipsWholeProbeAndKeepsRecognitionContext(wholeWindow: Bool) throws {
        let prefix = String(repeating: "x", count: try SharedContext.limit("screenBytes")) + ". password: "
        let visible = "syntheticSecret123"
        let text = (prefix + visible + ". After") as NSString
        let interval = NSRange(location: (prefix as NSString).length, length: (visible as NSString).length)
        var firstRead: NSRange?
        let result = try #require(try BoundedFieldReader.read(count: text.length, wholeWindow: wholeWindow, whole: {
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
    @Test(arguments: [false, true]) func longWholeSnapshotReusesItsNativeStorageForVisibleSource(wholeWindow: Bool) throws {
        let prefix = String(repeating: "x", count: try SharedContext.limit("screenBytes")) + ". Before "
        let text = (prefix + "Visible 😀" + ". After") as NSString
        var wholeReads = 0
        let result = try BoundedFieldReader.read(count: nil, wholeWindow: wholeWindow, whole: { wholeReads += 1; return text }, range: nil,
            visible: { count in
                #expect(count == text.length)
                return NSRange(location: (prefix as NSString).length, length: ("Visible 😀" as NSString).length)
            }, valid: { true })
        #expect(wholeReads == 1)
        #expect(result?.parts[1] == "Visible 😀")
    }
    @Test func wholeEligibilityUsesSharedGraphemesRatherThanUTF16Units() throws {
        let value = String(repeating: "😀", count: 15000) as NSString
        let result = try BoundedFieldReader.read(count: value.length, wholeWindow: false, whole: { nil }, range: { value.substring(with: $0) as NSString },
            visible: { _ in Issue.record("15000 graphemes fit whole-field policy"); return nil }, valid: { true })
        #expect(result?.parts[1] == value as String)
    }
    /// Reading the whole window, a field past a window but within the screen's budget is read
    /// whole, its whole value at once, and shown whole.
    @Test func aFieldWithinTheScreenBudgetIsReadAndShownWholeWithTheWholeWindow() throws {
        let screenBytes = try SharedContext.limit("screenBytes")
        for count in [try SharedContext.limit("sourceWindowBytes") + 1, screenBytes] {
            let value = (String(repeating: "x", count: count - 5) + " last") as NSString
            var visibleReads = 0
            let result = try #require(try BoundedFieldReader.read(count: value.length, wholeWindow: true, whole: { value },
                range: { value.substring(with: $0) as NSString }, visible: { _ in visibleReads += 1; return nil }, valid: { true }))
            #expect(visibleReads == 0)
            #expect(result.parts == ["", value as String, ""])
            var context = ScreenContext(appName: "Synthetic", bundleID: nil, windowTitle: nil)
            context.appendField(result.parts)
            #expect(!context.coreFailed)
            if count < screenBytes { #expect(try context.renderedText() == "> " + (value as String)) }
        }
    }
    /// Reading what the window shows, a field longer than a short one (more than 20,000
    /// characters, or past a window) is read by the part it shows: text scrolled out of view,
    /// however much the screen's budget could hold, never enters what the window shows.
    @Test func whatTheWindowShowsReadsALongFieldByThePartItShows() throws {
        let shown = "Visible start."
        for length in [20_001, try SharedContext.limit("sourceWindowBytes") + 1] {
            let value = (shown + String(repeating: "x", count: length - shown.count - 13) + "OFFSCREEN_END") as NSString
            #expect(value.length == length)
            var visibleReads = 0
            let result = try #require(try BoundedFieldReader.read(count: value.length, wholeWindow: false, whole: { value },
                range: { value.substring(with: $0) as NSString },
                visible: { _ in visibleReads += 1; return NSRange(location: 0, length: (shown as NSString).length) }, valid: { true }))
            #expect(visibleReads == 1)
            #expect(result.parts[1] == shown)
            var context = ScreenContext(appName: "Synthetic", bundleID: nil, windowTitle: nil)
            context.appendField(result.parts)
            let rendered = try context.renderedText()
            #expect(rendered == "> " + shown)
            #expect(!rendered.contains("OFFSCREEN_END"))
        }
        // A short field is still read whole, as before the whole window was read.
        let short = (shown + " OFFSCREEN_END") as NSString
        let whole = try #require(try BoundedFieldReader.read(count: short.length, wholeWindow: false, whole: { short },
            range: { short.substring(with: $0) as NSString },
            visible: { _ in Issue.record("a short field is read whole"); return nil }, valid: { true }))
        #expect(whole.parts == ["", short as String, ""])
    }
    @Test func malformedRangeDoesNotFallBackToWholeValue() throws {
        var wholeReads = 0
        #expect(throws: (any Error).self) {
            try BoundedFieldReader.read(count: 10, wholeWindow: false, whole: { wholeReads += 1; return "fallback" as NSString },
                range: { _ in "short" as NSString }, visible: { _ in nil }, valid: { true })
        }
        #expect(wholeReads == 0)
    }
    @Test func invalidationDiscardsTheField() throws {
        var valid = true
        #expect(throws: (any Error).self) {
            try BoundedFieldReader.read(count: 5, wholeWindow: false, whole: { nil }, range: { _ in valid = false; return "field" as NSString },
                visible: { _ in nil }, valid: { valid })
        }
    }
}
