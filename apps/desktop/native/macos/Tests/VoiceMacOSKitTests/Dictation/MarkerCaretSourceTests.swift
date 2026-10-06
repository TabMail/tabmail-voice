// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import ApplicationServices
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

    /// Chromium: text markers but no marker-index conversion, and a character range that is wrong on
    /// an empty line; the selection comes from the lengths between the markers.
    @Test(arguments: [(96, 0), (9, 0), (0, 0), (120, 0), (90, 6), (0, 120)])
    func selectionIsTheMarkersOffsetsInTheField(start: Int, length: Int) throws {
        let field = MarkerField()
        let markers = try #require(MarkerCaretSource.selection(selection: field.range(start, start + length), whole: field.range(0, 120),
                                                               parameterized: field.answer))
        #expect(markers.range == NSRange(location: start, length: length))
    }

    /// The field is counted in its markers, the characters its string ranges hold, whatever its value
    /// counts: Chromium's value can hold a paragraph break the markers leave out.
    @Test func theFieldIsCountedInItsMarkers() throws {
        let field = MarkerField()
        let markers = try #require(MarkerCaretSource.selection(selection: field.range(96, 96), whole: field.range(4, 124),
                                                               parameterized: field.answer))
        #expect(markers.count == 120)
        #expect(markers.range == NSRange(location: 92, length: 0))
    }

    @Test func selectionIsNoneOutsideTheField() throws {
        let field = MarkerField()
        #expect(MarkerCaretSource.selection(selection: field.range(110, 110), whole: field.range(0, 100),
                                            parameterized: field.answer) == nil)
    }

    @Test func selectionIsNoneWithoutMarkerLengths() throws {
        let field = MarkerField()
        #expect(MarkerCaretSource.selection(selection: field.range(96, 96), whole: field.range(0, 120),
                                            parameterized: { name, value in name == "AXLengthForTextMarkerRange" ? nil : field.answer(name, value) }) == nil)
    }

    @Test func selectionIsNoneForAnythingButMarkerRanges() throws {
        let field = MarkerField()
        #expect(MarkerCaretSource.selection(selection: NSArray(array: [96, 96]), whole: field.range(0, 120),
                                            parameterized: field.answer) == nil)
        #expect(MarkerCaretSource.selection(selection: field.range(96, 96), whole: NSArray(array: [0, 120]),
                                            parameterized: field.answer) == nil)
    }

    /// A selection made backward (its anchor after its focus) is the same selection made forward.
    @Test func aBackwardSelectionIsTheSameSelection() throws {
        let field = MarkerField()
        let markers = try #require(MarkerCaretSource.selection(selection: field.range(130, 96), whole: field.range(0, 140),
                                                               parameterized: field.answer))
        #expect(markers.range == NSRange(location: 96, length: 34))
    }

    @Test func selectionIsNoneForANegativeLength() throws {
        let field = MarkerField()
        #expect(MarkerCaretSource.selection(selection: field.range(96, 96), whole: field.range(0, 120), parameterized: { name, value in
            name == "AXLengthForTextMarkerRange" ? NSNumber(value: -1) : field.answer(name, value)
        }) == nil)
    }

    /// An element with no character count (a page, a link) gets no caret read from its markers.
    @Test func anElementWithNoCharacterCountIsNotRead() {
        let field = MarkerField()
        #expect(ScreenContextReader.valueCaretWindow(snapshot: {
            ScreenContextReader.valueSnapshot(markers: { (field.range(100, 110), field.range(0, 140)) }, parameterized: field.answer,
                                              characters: { nil }, string: Self.string)
        }, string: Self.string, focused: { true }) == nil)
    }

    /// Markers counting nothing in a field that has characters ask for no text before its start.
    @Test func markersCountingNothingAskForNoTextBeforeTheField() throws {
        let field = MarkerField()
        var requests: [NSRange] = []
        let result = try #require(ScreenContextReader.valueCaretWindow(snapshot: {
            ScreenContextReader.valueSnapshot(markers: { (field.range(0, 0), field.range(0, 0)) }, parameterized: field.answer,
                                              characters: { (140, NSRange(location: 9, length: 0)) }, string: { range in
                requests.append(range)
                return Self.string(range)
            })
        }, string: Self.string, focused: { true }))
        #expect(requests.allSatisfy { $0.location >= 0 })
        #expect(result.parts == [Self.text.substring(to: 9), "", Self.text.substring(from: 9)])
    }

    /// The read of a Chromium-shaped field: 140 characters in its markers and string ranges, and a
    /// value counting one more (a paragraph break the markers leave out) with a character range on
    /// the wrong line.
    private static var text: NSString { (String(repeating: "x", count: 95) + "?" + String(repeating: "y", count: 44)) as NSString }

    private static func string(_ range: NSRange) -> NSString? {
        range.location >= 0 && range.location + range.length <= text.length ? text.substring(with: range) as NSString : nil
    }

    private func read(_ field: MarkerField = MarkerField(), anchor: Int, focus: Int, markerCount: Int = 140,
                      characters: (count: Int, range: NSRange) = (141, NSRange(location: 9, length: 0)),
                      changes: Bool = false, focused: Bool = true) -> SharedContext.CaretWindow? {
        var snapshots = 0
        return ScreenContextReader.valueCaretWindow(snapshot: {
            snapshots += 1
            return ScreenContextReader.valueSnapshot(markers: { (field.range(anchor, changes && snapshots > 1 ? focus + 1 : focus), field.range(0, markerCount)) },
                                                     parameterized: field.answer, characters: { characters }, string: Self.string)
        }, string: Self.string, focused: { focused })
    }

    @Test func aChromiumFieldIsReadNearItsEndThoughItsValueCountsMore() throws {
        let result = try #require(read(anchor: 138, focus: 138))
        #expect(!result.selectionUnavailable)
        #expect(result.parts == [Self.text.substring(to: 138), "", Self.text.substring(from: 138)])
    }

    @Test func aChromiumSelectionMadeBackwardIsReadAsMadeForward() throws {
        let backward = try #require(read(anchor: 110, focus: 96))
        #expect(!backward.selectionUnavailable)
        #expect(backward.parts == [Self.text.substring(to: 96), Self.text.substring(with: NSRange(location: 96, length: 14)), Self.text.substring(from: 110)])
        #expect(backward.parts == read(anchor: 96, focus: 110)?.parts)
    }

    @Test(arguments: [(true, true), (false, false)])
    func aFieldChangedOrLeftWhileReadIsUnavailable(changes: Bool, focused: Bool) throws {
        let result = try #require(read(anchor: 100, focus: 100, changes: changes, focused: focused))
        #expect(result.selectionUnavailable)
        #expect(result.parts == ["", Redactor.placeholder, ""])
    }

    /// A field that stops answering while it is read is unavailable, though it keeps the focus.
    @Test func aFieldUnreadableAfterItsReadIsUnavailable() throws {
        var snapshots = 0
        let result = try #require(ScreenContextReader.valueCaretWindow(snapshot: {
            snapshots += 1
            return snapshots > 1 ? nil : ScreenContextReader.ValueSnapshot(count: 140, range: NSRange(location: 9, length: 0), markers: false)
        }, string: Self.string, focused: { true }))
        #expect(result.selectionUnavailable)
        #expect(result.parts == ["", Redactor.placeholder, ""])
    }

    /// A field without text markers is read by its character count and range.
    @Test func aFieldWithoutMarkersIsReadByItsCharacterRange() throws {
        let result = try #require(ScreenContextReader.valueCaretWindow(snapshot: {
            ScreenContextReader.valueSnapshot(markers: { nil }, parameterized: { _, _ in nil }, characters: { (140, NSRange(location: 9, length: 0)) },
                                              string: Self.string)
        }, string: Self.string, focused: { true }))
        #expect(result.parts == [Self.text.substring(to: 9), "", Self.text.substring(from: 9)])
    }

    @Test func aFieldWithNeitherIsNotRead() {
        #expect(ScreenContextReader.valueCaretWindow(snapshot: {
            ScreenContextReader.valueSnapshot(markers: { nil }, parameterized: { _, _ in nil }, characters: { nil }, string: { _ in nil })
        }, string: { _ in nil }, focused: { true }) == nil)
    }

    /// Markers that are no marker ranges leave the field to its character count and range.
    @Test func aFieldWhoseMarkersGiveNoSelectionIsReadByItsCharacterRange() throws {
        let result = try #require(ScreenContextReader.valueCaretWindow(snapshot: {
            ScreenContextReader.valueSnapshot(markers: { (NSArray(array: [96, 96]), NSArray(array: [0, 140])) }, parameterized: MarkerField().answer,
                                              characters: { (140, NSRange(location: 9, length: 0)) }, string: Self.string)
        }, string: Self.string, focused: { true }))
        #expect(result.parts == [Self.text.substring(to: 9), "", Self.text.substring(from: 9)])
    }

    /// A field whose text can't be read around the caret is unavailable, not unread.
    @Test func aFieldWhoseTextCantBeReadIsUnavailable() throws {
        let result = try #require(ScreenContextReader.valueCaretWindow(snapshot: {
            ScreenContextReader.valueSnapshot(markers: { nil }, parameterized: { _, _ in nil }, characters: { (140, NSRange(location: 9, length: 0)) },
                                              string: Self.string)
        }, string: { _ in nil }, focused: { true }))
        #expect(result.selectionUnavailable)
        #expect(result.parts == ["", Redactor.placeholder, ""])
    }

    /// Chromium counts an image as a character in its markers but not in its string ranges: the
    /// markers then end past the text, and the field is read by its character count and range,
    /// which agree with its string ranges, so the text read is the text around the caret.
    @Test func aChromiumFieldWithAnImageIsReadByItsCharacterRange() throws {
        let result = try #require(read(anchor: 139, focus: 139, markerCount: 141, characters: (140, NSRange(location: 138, length: 0))))
        #expect(!result.selectionUnavailable)
        #expect(result.parts == [Self.text.substring(to: 138), "", Self.text.substring(from: 138)])
    }

    /// Markers that end short of the text (string ranges reaching past them) aren't trusted either.
    @Test func aChromiumFieldWhoseTextRunsPastItsMarkersIsReadByItsCharacterRange() throws {
        let result = try #require(read(anchor: 100, focus: 100, markerCount: 139, characters: (140, NSRange(location: 101, length: 0))))
        #expect(result.parts == [Self.text.substring(to: 101), "", Self.text.substring(from: 101)])
    }

    /// An empty Chromium text field gives its placeholder in its markers; its value has no
    /// characters, and it is read as empty.
    @Test func anEmptyChromiumFieldIsEmptyWhateverItsMarkersHold() throws {
        let result = try #require(read(anchor: 0, focus: 0, characters: (0, NSRange(location: 0, length: 0))))
        #expect(!result.selectionUnavailable)
        #expect(result.parts == ["", "", ""])
    }

    /// A caret on an empty line under "?" starts a paragraph whose break Chromium's string ranges
    /// leave out: the text before it ends in that break, not right after the "?" (ADR-DESK-007).
    @Test func aCaretStartingAParagraphGetsTheBreakItsTextLeavesOut() throws {
        let result = try #require(read(MarkerField(paragraphs: [0, 96]), anchor: 96, focus: 96))
        #expect(result.parts == [Self.text.substring(to: 96) + "\n", "", Self.text.substring(from: 96)])
    }

    @Test func aCaretInsideAParagraphGetsNoBreak() throws {
        let result = try #require(read(MarkerField(paragraphs: [0, 90]), anchor: 96, focus: 96))
        #expect(result.parts == [Self.text.substring(to: 96), "", Self.text.substring(from: 96)])
    }

    /// A selection made backward starts at its focus: that is where the paragraph must start.
    /// Made forward, it starts at its anchor.
    @Test func aBackwardSelectionStartingAParagraphGetsTheBreak() throws {
        let field = MarkerField(paragraphs: [0, 96, 105])
        let result = try #require(read(field, anchor: 110, focus: 96))
        #expect(result.parts == [Self.text.substring(to: 96) + "\n", Self.text.substring(with: NSRange(location: 96, length: 14)), Self.text.substring(from: 110)])
        #expect(read(MarkerField(paragraphs: [0, 90, 105]), anchor: 110, focus: 96)?.parts[0] == Self.text.substring(to: 96))
        #expect(read(field, anchor: 96, focus: 110)?.parts[0] == Self.text.substring(to: 96) + "\n")
    }

    /// A field whose paragraph changes while it is read is unavailable, like one whose text does.
    @Test func aFieldWhoseParagraphChangesWhileReadIsUnavailable() throws {
        var snapshots = 0
        let result = try #require(ScreenContextReader.valueCaretWindow(snapshot: {
            snapshots += 1
            let field = MarkerField(paragraphs: snapshots > 1 ? [0, 90] : [0, 96])
            return ScreenContextReader.valueSnapshot(markers: { (field.range(96, 96), field.range(0, 140)) }, parameterized: field.answer,
                                                     characters: { (141, NSRange(location: 9, length: 0)) }, string: Self.string)
        }, string: Self.string, focused: { true }))
        #expect(result.selectionUnavailable)
        #expect(result.parts == ["", Redactor.placeholder, ""])
    }

    /// A secret the caret sits inside, at the start of a line it wrapped onto, is read as one text
    /// and redacted whole (ADR-DESK-007, ADR-DESK-046): nothing is put between the texts around
    /// the caret.
    /// The same when the provider says a paragraph starts at the caret: the break it adds there is
    /// one the screen's render won't let split the secret, so the text around the caret is withheld.
    @Test(arguments: [false, true])
    func aSecretWrappedAtTheCaretIsRedactedWhole(paragraphAtTheCaret: Bool) throws {
        let head = "sk" + "-" + "a1B2c3D4e", tail = "5F6g7H8i9J0k1L2"
        let text = ("Key " + head + tail + " end") as NSString
        let caret = 4 + head.utf16.count
        let field = MarkerField(paragraphs: paragraphAtTheCaret ? [0, caret] : [])
        let read = ScreenContextReader.valueCaretWindow(snapshot: {
            ScreenContextReader.valueSnapshot(markers: { (field.range(caret, caret), field.range(0, text.length)) }, parameterized: field.answer,
                                              characters: { (text.length, NSRange(location: 0, length: 0)) }, string: { range in
                range.location >= 0 && range.location + range.length <= text.length ? text.substring(with: range) as NSString : nil
            })
        }, string: { text.substring(with: $0) as NSString }, focused: { true })
        let window = try #require(read)
        #expect(window.parts == ["Key " + head + (paragraphAtTheCaret ? "\n" : ""), "", tail + " end"])
        var context = ScreenContext(appName: "Example Browser", bundleID: "org.example.browser")
        context.textBeforeCaret = window.parts[0]
        context.selectedText = window.parts[1]
        context.textAfterCaret = window.parts[2]
        context.appendCaret()
        let reply = context.json
        for name in ["textBeforeCaret", "textAfterCaret", "renderedText", "logDescription"] {
            let value = try #require(reply[name]?.string)
            #expect(!value.contains(head) && !value.contains(tail), "\(name)")
        }
    }

    /// Real text-marker objects holding an offset, answering as Chromium does: lengths and unordered
    /// ranges, no index conversion. A range keeps its markers in the order given, as a selection made
    /// backward does.
    /// A Gmail compose field as Chromium's tree gives it (measured 2026-10-06): a line of text, an
    /// empty <div>, a <div> holding a sentence edited into runs, and the signature's <div>. Each
    /// block, and text after one, starts where the text may leave out its break.
    @Test func blockStartsAreTheBlocksNearTheSelection() throws {
        let field = Node("field", children: [
            Node("text", 0, 16),
            Node("block", 16, 1),
            Node("block", 17, 30, children: [Node("text", 17, 25), Node("text", 42, 4), Node("text", 46, 1)]),
            Node("block", 47, 124, children: [Node("text", 49, 2), Node("text", 52, 13)]),
            Node("text", 171, 5),
        ])
        func starts(_ range: NSRange, within units: Int, elements: Int = 500) -> [Int]? {
            MarkerCaretSource.blockStarts(in: field, around: range, within: units, elements: elements,
                                          children: \.children, isBlock: { $0.kind == "block" }, span: \.span)
        }
        #expect(starts(NSRange(location: 47, length: 0), within: 4000) == [16, 17, 47, 171])
        // Only those within the window, found without looking at every sibling before it.
        #expect(starts(NSRange(location: 47, length: 0), within: 10) == [47])
        #expect(starts(NSRange(location: 20, length: 0), within: 3) == [17])
        // Too many looks, or an element with no place, gives none.
        #expect(starts(NSRange(location: 47, length: 0), within: 4000, elements: 3) == nil)
        #expect(MarkerCaretSource.blockStarts(in: field, around: NSRange(location: 47, length: 0), within: 4000, elements: 500,
                                              children: \.children, isBlock: { $0.kind == "block" }, span: { _ in nil }) == nil)
    }

    private struct Node {
        let kind: String
        let span: NSRange?
        let children: [Node]
        init(_ kind: String, _ start: Int = 0, _ length: Int = 0, children: [Node] = []) {
            self.kind = kind
            span = NSRange(location: start, length: length)
            self.children = children
        }
    }

    private struct MarkerField {
        /// Where its paragraphs start; none: it answers no paragraph.
        var paragraphs: [Int] = []
        func marker(_ offset: Int) -> AXTextMarker {
            var value = offset
            return withUnsafeBytes(of: &value) { AXTextMarkerCreate(nil, $0.bindMemory(to: UInt8.self).baseAddress!, $0.count) }
        }
        func range(_ start: Int, _ end: Int) -> CFTypeRef { AXTextMarkerRangeCreate(nil, marker(start), marker(end)) }
        static func offset(_ marker: AXTextMarker) -> Int {
            UnsafeRawPointer(AXTextMarkerGetBytePtr(marker)).loadUnaligned(as: Int.self)
        }
        func answer(_ name: String, _ value: CFTypeRef) -> CFTypeRef? {
            switch name {
            case "AXLengthForTextMarkerRange":
                let range = value as! AXTextMarkerRange
                let start = Self.offset(AXTextMarkerRangeCopyStartMarker(range)), end = Self.offset(AXTextMarkerRangeCopyEndMarker(range))
                return NSNumber(value: abs(end - start))
            case "AXTextMarkerRangeForUnorderedTextMarkers":
                let pair = (value as! NSArray).map { Self.offset($0 as! AXTextMarker) }
                return range(pair.min()!, pair.max()!)
            case "AXParagraphTextMarkerRangeForTextMarker":
                let at = Self.offset(value as! AXTextMarker)
                guard let start = paragraphs.last(where: { $0 <= at }) else { return nil }
                return range(start, paragraphs.first(where: { $0 > at }) ?? at)
            default: return nil
            }
        }
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
