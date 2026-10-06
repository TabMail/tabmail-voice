// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation
import ApplicationServices
import VoiceHelperSupport
import Testing
@testable import VoiceMacOSKit

struct TerminalViewportReaderTests {
    @Test func aggregateSourceRejectsSecureDescendantsAndIncompleteMetadata() {
        let children: (Int) -> [Int] = { $0 == 0 ? [1] : [] }
        #expect(!TerminalViewportReader.readableSubtree(0, limit: 5, valid: { true }, protected: { $0 == 1 }, children: children))
        #expect(TerminalViewportReader.readableSubtree(0, limit: 5, valid: { true }, protected: { _ in false }, children: children))
        #expect(!TerminalViewportReader.readableSubtree(0, limit: 1, valid: { true }, protected: { _ in false }, children: children))
        #expect(!TerminalViewportReader.readableSubtree(0, limit: 5, valid: { true }, protected: { _ in false }, children: { [$0] }))
        #expect(!TerminalViewportReader.readableSubtree(0, limit: 5, valid: { false }, protected: { _ in false }, children: children))
    }

    @Test func neverAcquiresHiddenGapsOrHistory() {
        let text = "hidden-prefixVisiblehidden-gapOtherhidden-tail" as NSString
        let ranges = [NSRange(location: 13, length: 7), NSRange(location: 30, length: 5)]
        var reads: [NSRange] = []
        let result = TerminalViewportReader.capture(ranges: ranges, count: text.length, unitBudget: 12, read: {
            reads.append($0)
            return text.substring(with: $0) as NSString
        }, valid: { true })
        #expect(result?.texts == ["Visible", "Other"])
        #expect(reads == ranges)
    }
    @Test func keepsTheFirstReadAndRefusesOnPrivacyInvalidation() {
        var reads = 0
        let range = NSRange(location: 40, length: 3)
        let changing = TerminalViewportReader.capture(ranges: [range], count: 100, unitBudget: 3, read: { _ in
            reads += 1
            return reads == 1 ? "old" : "new"
        }, valid: { true })
        #expect(changing?.texts == ["old"])
        #expect(reads == 1)
        reads = 0
        let hidden = TerminalViewportReader.capture(ranges: [range], count: 100, unitBudget: 3, read: { _ in reads += 1; return "old" }, valid: { false })
        #expect(hidden == nil)
        #expect(reads == 0)
    }
    @Test func budgetAndMalformedRangesRefuseBeforeTextRead() {
        for ranges in [[NSRange(location: 0, length: 4)], [NSRange(location: 8, length: 3)], [NSRange(location: 3, length: 1), NSRange(location: 2, length: 1)]] {
            var reads = 0
            #expect(TerminalViewportReader.capture(ranges: ranges, count: 10, unitBudget: 3, read: { _ in reads += 1; return "" }, valid: { true }) == nil)
            #expect(reads == 0)
        }
    }
    @Test func geometryClipsBothAxesWithoutReplacingGapsByTheirEnvelope() {
        let lines = [NSRange(location: 0, length: 5), NSRange(location: 5, length: 5), NSRange(location: 10, length: 5)]
        let clip = CGRect(x: 10, y: 10, width: 20, height: 10)
        let result = TerminalViewportReader.visibleRanges(lines: lines, clip: clip, bounds: { range in
            CGRect(x: (range.location % 5) * 10, y: (range.location / 5) * 10, width: range.length * 10, height: 10)
        }, valid: { true })
        #expect(result == [NSRange(location: 6, length: 2)])
    }
    @Test func clippedLongLineUsesRangeProofsInsteadOfPerCharacterAXCalls() {
        var calls = 0
        let ranges = TerminalViewportReader.visibleRanges(lines: [NSRange(location: 0, length: 4096)],
            clip: CGRect(x: 8, y: 0, width: 32752, height: 20), bounds: { range in
                calls += 1
                return CGRect(x: range.location * 8, y: 0, width: range.length * 8, height: 20)
            }, valid: { true })
        #expect(ranges == [NSRange(location: 1, length: 4094)])
        #expect(calls < 100)
    }

    @Test func multilineEndpointBoxesDoNotHideVisibleColumnsOrExposeHiddenColumns() {
        let ranges = TerminalViewportReader.visibleRanges(lines: [NSRange(location: 0, length: 6)],
            clip: CGRect(x: 10, y: 0, width: 10, height: 30), bounds: { range in
                let first = range.location / 2
                let last = (NSMaxRange(range) - 1) / 2
                if first != last {
                    return CGRect(x: 0, y: first * 10, width: 0, height: (last - first + 1) * 10)
                }
                return CGRect(x: (range.location % 2) * 10, y: first * 10, width: range.length * 10, height: 10)
            }, isSingleLine: { $0.location / 2 == (NSMaxRange($0) - 1) / 2 }, valid: { true })
        #expect(ranges == [NSRange(location: 1, length: 1), NSRange(location: 3, length: 1), NSRange(location: 5, length: 1)])
    }

    @Test func wholeVisibleLinesPreserveSpacesAndBlankRows() {
        let text = "> hello world\n  \nstatus bar" as NSString
        let range = NSRange(location: 0, length: text.length)
        var calls = 0
        let ranges = TerminalViewportReader.visibleRanges(lines: [range], clip: CGRect(x: 0, y: 0, width: 300, height: 100), bounds: { _ in calls += 1; return CGRect(x: 0, y: 0, width: 200, height: 60) }, valid: { true })
        #expect(calls == 1)
        #expect(ranges == [range])
        let result = TerminalViewportReader.capture(ranges: ranges ?? [], count: text.length, unitBudget: 100, read: { text.substring(with: $0) as NSString }, valid: { true })
        #expect(result?.texts == [text as String])
    }
    @Test func rejectsAnAcquisitionThatSplitsASurrogatePair() {
        var surrogate: unichar = 0xD83D
        let invalid = NSString(characters: &surrogate, length: 1)
        #expect(TerminalViewportReader.capture(ranges: [NSRange(location: 0, length: 1)], count: 2, unitBudget: 2, read: { _ in invalid }, valid: { true }) == nil)
    }
    @Test func nativeBridgeProjectsReferenceCaretAndSharesLimits() throws {
        let limits = try TerminalViewportReader.project(["limits": true])
        #expect((limits["bytes"]?.integer ?? 0) > 0)
        let output = try TerminalViewportReader.project([
            "complete": true, "focusedSurface": 1,
            "caret": ["status": "exact", "surface": 1, "run": 0, "offset": 18],
            "surfaces": [["id": 1, "frame": [0, 0, 400, 200],
                          "runs": [["id": 0, "text": "first line\n> hello world\nstatus bar", "connected": false, "startKnown": false, "endKnown": false]],
                          "selection": ["complete": true, "ranges": []]]]
        ])
        #expect(output["caret"]?["status"]?.string == "exact")
        #expect(output["caret"]?["offset"]?.integer == 18)
        #expect(output["renderedText"]?.string == "[Terminal surface 1]\nfirst line\n> hello world\nstatus bar")
    }

}

struct TerminalViewportWireTests {
    @Test func projectsAndRedactsBeforeSendingTypedCaretToTheApp() throws {
        var context = ScreenContext(appName: "Synthetic Terminal", bundleID: "example.terminal")
        TerminalViewportReader.finish([
            "complete": true, "focusedSurface": 1, "caret": ["status": "exact", "surface": 1, "run": 0, "offset": 24],
            "surfaces": [["id": 1, "frame": [0, 0, 400, 200],
                          "runs": [["id": 0, "text": "token=abc123456789\n> hello world", "connected": false, "startKnown": false, "endKnown": false]],
                          "selection": ["complete": true, "ranges": []]]]
        ], into: &context)
        let wire = context.json
        #expect(wire["hidden"] == nil)
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string == "exact")
        #expect(wire["renderedText"]?.string == "[Terminal surface 1]\ntoken=[redacted]\n> hello world")
        #expect(wire["textBeforeCaret"]?.string == "")
        #expect(wire["logDescription"]?.string?.contains("abc123456789") == false)
    }
    @Test func incompleteSelectionAndUnavailableCaretSurviveTheWire() throws {
        var context = ScreenContext(appName: "Synthetic Terminal", bundleID: nil)
        TerminalViewportReader.finish([
            "complete": false, "focusedSurface": 1, "caret": ["status": "unavailable"],
            "surfaces": [["id": 1, "frame": [0, 0, 400, 200],
                          "runs": [["id": 0, "text": "visible", "connected": false, "startKnown": false, "endKnown": false]],
                          "selection": ["complete": false, "ranges": [["run": 0, "start": 0, "end": 7]]]]]
        ], into: &context)
        let wire = context.json
        #expect(wire["selectionRedacted"]?.bool == true)
        #expect(wire["selectedText"]?.string == "[redacted]")
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string == "unavailable")
        #expect(wire["renderedText"]?.string == "[Terminal surface 1]\nvisible")
    }
    @Test func nonterminalWireDoesNotEmitNullViewport() {
        let context = ScreenContext(appName: "Synthetic Notes", bundleID: nil)
        #expect(context.json["terminalViewport"] == nil)
    }
}

/// Answers raw AX attributes and parameterized calls. No prebuilt viewport JSON:
/// the production adapter derives visibility, source offsets and the wire result.
private final class TerminalAXFixture {
    var lines = ["history\n", "> hello world\n", "status bar\n", "hidden\n"]
    var selection = NSRange(location: 15, length: 0)
    var insertionLine: Int? = 1
    var reads: [NSRange] = []
    var forbidden: [String] = []
    var afterRead: (() -> Void)?
    var text: NSString { lines.joined() as NSString }
    var ranges: [NSRange] {
        var start = 0
        return lines.map { line in
            let length = (line as NSString).length
            defer { start += length }
            return NSRange(location: start, length: length)
        }
    }
    func line(at offset: Int) -> Int? {
        ranges.firstIndex { offset >= $0.location && offset < NSMaxRange($0) }
    }
    func value(_ range: NSRange) -> CFTypeRef? {
        var range = CFRange(location: range.location, length: range.length)
        return AXValueCreate(.cfRange, &range)
    }
    var source: TerminalViewportReader.Source {
        TerminalViewportReader.Source(attribute: { [self] name in
            switch name {
            case kAXNumberOfCharactersAttribute: return NSNumber(value: text.length)
            case kAXSelectedTextRangeAttribute: return value(selection)
            case kAXInsertionPointLineNumberAttribute: return insertionLine.map { NSNumber(value: $0) }
            default: forbidden.append(name); return nil
            }
        }, parameter: { [self] name, argument in
            switch name {
            case kAXLineForIndexParameterizedAttribute:
                guard let index = argument as? NSNumber, let line = line(at: index.intValue) else { return nil }
                return NSNumber(value: line)
            case kAXRangeForLineParameterizedAttribute:
                guard let index = argument as? NSNumber, ranges.indices.contains(index.intValue) else { return nil }
                return value(ranges[index.intValue])
            case kAXStringForRangeParameterizedAttribute:
                guard CFGetTypeID(argument) == AXValueGetTypeID() else { return nil }
                var requested = CFRange()
                guard AXValueGetValue(argument as! AXValue, .cfRange, &requested) else { return nil }
                let range = NSRange(location: requested.location, length: requested.length)
                // Only the two visible lines are authorized, never scrollback.
                guard range.location >= ranges[1].location, NSMaxRange(range) <= NSMaxRange(ranges[2]) else {
                    forbidden.append("hidden text"); return nil
                }
                reads.append(range)
                let result = text.substring(with: range)
                afterRead?()
                return result as NSString
            default: forbidden.append(name); return nil
            }
        }, bounds: { [self] range in
            guard let line = line(at: range.location), let last = self.line(at: range.location + max(0, range.length - 1)) else { return nil }
            if last != line {
                return CGRect(x: 0, y: line * 10, width: ranges[line...last].map(\.length).max()! * 10, height: (last - line + 1) * 10)
            }
            return CGRect(x: (range.location - ranges[line].location) * 10,
                          y: line * 10, width: range.length * 10, height: 10)
        })
    }
    func capture(focused: Bool = true) -> TerminalViewportReader.Surface? {
        TerminalViewportReader.surface(source, id: 0, clip: CGRect(x: 0, y: 10, width: 400, height: 20),
                                       focused: focused, startKnown: false, endKnown: false, valid: { true })
    }
    func wire() throws -> JSON {
        let captured = try #require(capture())
        var context = ScreenContext(appName: "Synthetic Terminal", bundleID: "example.terminal")
        TerminalViewportReader.finish(["complete": true, "focusedSurface": 0,
                                       "caret": captured.caret, "surfaces": .array([captured.source])], into: &context)
        return context.json
    }
}

struct TerminalAXAdapterTests {

    @Test func visibleCaptureDoesNotRebuildProviderLineRanges() throws {
        let provider = TerminalAXFixture()
        let original = provider.source
        var lineRangeCalls = 0
        let source = TerminalViewportReader.Source(attribute: original.attribute, parameter: { name, argument in
            if name == kAXRangeForLineParameterizedAttribute { lineRangeCalls += 1; return nil }
            return original.parameter(name, argument)
        }, bounds: original.bounds)
        let result = try #require(TerminalViewportReader.surface(source, id: 0,
            clip: CGRect(x: 0, y: 10, width: 400, height: 20), focused: true,
            startKnown: false, endKnown: false, valid: { true }))
        #expect(result.source["runs"]?.array?.compactMap { $0["text"]?.string }.joined() == "> hello world\nstatus bar\n")
        #expect(result.caret["status"]?.string == "exact")
        #expect(lineRangeCalls == 0)
        #expect(provider.forbidden.isEmpty)
    }


    @Test func countOrSelectionMutationDuringCaptureKeepsTheKeyDownText() {
        for changeCount in [true, false] {
            let provider = TerminalAXFixture()
            let source = provider.source
            let changed = TerminalViewportReader.Source(attribute: { name in
                if changeCount, name == kAXNumberOfCharactersAttribute, !provider.reads.isEmpty {
                    return NSNumber(value: provider.text.length + 1)
                }
                if !changeCount, name == kAXSelectedTextRangeAttribute, !provider.reads.isEmpty {
                    var range = CFRange(location: 9, length: 1)
                    return AXValueCreate(.cfRange, &range)
                }
                return source.attribute(name)
            }, parameter: source.parameter, bounds: source.bounds)
            let result = TerminalViewportReader.surface(changed, id: 0,
                clip: CGRect(x: 0, y: 10, width: 400, height: 20), focused: true,
                startKnown: false, endKnown: false, valid: { true })
            #expect(result?.source["runs"]?.array?.compactMap { $0["text"]?.string }.joined() == "> hello world\nstatus bar\n")
            #expect(provider.forbidden.isEmpty)
        }
    }

    @Test func geometryPlanningRevalidatesBeforeAnyTextRead() {
        let provider = TerminalAXFixture()
        let original = provider.source
        var stillValid = true
        let changed = TerminalViewportReader.Source(attribute: original.attribute, parameter: original.parameter,
            bounds: { range in stillValid = false; return original.bounds(range) })
        let result = TerminalViewportReader.surface(changed, id: 0,
            clip: CGRect(x: 0, y: 10, width: 400, height: 20), focused: true,
            startKnown: false, endKnown: false, geometryValid: { true }, valid: { stillValid })
        #expect(result == nil)
        #expect(provider.reads.isEmpty)
        #expect(provider.forbidden.isEmpty)
    }

    @Test func geometryDeadlineRefusesWithoutTextAcquisition() {
        let provider = TerminalAXFixture()
        let result = TerminalViewportReader.surface(provider.source, id: 0,
            clip: CGRect(x: 0, y: 10, width: 400, height: 20), focused: true,
            startKnown: false, endKnown: false, geometryValid: { false }, valid: { true })
        #expect(result == nil)
        #expect(provider.reads.isEmpty)
    }

    @Test func geometryQueriesDoNotRepeatCrossProcessFocusValidation() throws {
        let provider = TerminalAXFixture()
        provider.lines[1] = String(repeating: "x", count: 4096)
        var validations = 0
        let result = try #require(TerminalViewportReader.surface(provider.source, id: 0,
            clip: CGRect(x: 0, y: 10, width: 400, height: 20), focused: true,
            startKnown: false, endKnown: false, valid: { validations += 1; return true }))
        #expect(result.source["runs"]?.array?.compactMap { $0["text"]?.string }.joined() == String(repeating: "x", count: 40) + "status bar\n")
        #expect(validations < 20)
        #expect(provider.forbidden.isEmpty)
    }

    @Test func displayedLinesAndNativeCaretReachFinalWireWithoutTmux() throws {
        let provider = TerminalAXFixture()
        let wire = try provider.wire()
        #expect(wire["renderedText"]?.string == "[Terminal surface 0]\n> hello world\nstatus bar\n")
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string == "exact")
        #expect(wire["terminalViewport"]?["caret"]?["offset"]?.integer == 7)
        #expect(provider.reads == [NSRange(location: 8, length: 25)])
        #expect(provider.forbidden.isEmpty)
    }

    @Test func unicodeNativeOffsetsAndRedactionReachTheWire() throws {
        let provider = TerminalAXFixture()
        provider.lines[1] = "界😀 e\u{301} token=abc123456789 > hi\n"
        let prefix = "界😀 e\u{301} token=abc123456789 > "
        provider.selection = NSRange(location: 8 + (prefix as NSString).length, length: 0)
        let wire = try provider.wire()
        #expect(wire["renderedText"]?.string == "[Terminal surface 0]\n界😀 e\u{301} token=[redacted] > hi\nstatus bar\n")
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string == "exact")
        #expect(wire["terminalViewport"]?["caret"]?["offset"]?.integer == ("界😀 e\u{301} token=[redacted] > " as NSString).length)
        #expect(provider.forbidden.isEmpty)
    }

    @Test func selectionDoesNotFabricateCaretAndHiddenSelectionRefusesEdit() throws {
        let provider = TerminalAXFixture()
        provider.selection = NSRange(location: 10, length: 5)
        var wire = try provider.wire()
        #expect(wire["selectedText"]?.string == "hello")
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string == "unavailable")
        provider.selection = NSRange(location: 0, length: 13)
        wire = try provider.wire()
        #expect(wire["selectedText"]?.string == "[redacted]")
        #expect(wire["selectionRedacted"]?.bool == true)
        #expect(provider.forbidden.isEmpty)
    }

    @Test func missingOrOffscreenCaretDoesNotEraseVisibleText() throws {
        let provider = TerminalAXFixture()
        provider.insertionLine = nil
        var wire = try provider.wire()
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string != "exact")
        #expect(wire["renderedText"]?.string?.contains("> hello world") == true)
        provider.selection = NSRange(location: 2, length: 0)
        wire = try provider.wire()
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string == "outsideViewport")
        #expect(provider.forbidden.isEmpty)
    }

    @Test func unfocusedSurfaceCannotClaimCaret() throws {
        let provider = TerminalAXFixture()
        let unfocused = try #require(provider.capture(focused: false))
        #expect(unfocused.caret["status"]?.string == "unavailable")
        #expect(provider.forbidden.isEmpty)
    }
}

private final class TerminalCollectorFixture: TerminalTree {
    let base = FakeScreenTree()
    var providers: [ObjectIdentifier: TerminalAXFixture] = [:]
    var acquisitions: [FakeElement] = []
    var genericReads = 0
    var onAcquire: (() -> Void)?
    func children(of element: FakeElement) -> [FakeElement] { base.children(of: element) }
    func frame(of element: FakeElement) -> CGRect? { base.frame(of: element) }
    func string(_ element: FakeElement, _ name: String) -> String? { base.string(element, name) }
    func page(of element: FakeElement) -> PageHost { base.page(of: element) }
    func fieldSource(of element: FakeElement, windowFrame: CGRect?) -> [String]? { genericReads += 1; return nil }
    func caretWindow(of element: FakeElement) -> SharedContext.CaretWindow? { genericReads += 1; return nil }
    func isSame(_ first: FakeElement, _ second: FakeElement) -> Bool { first === second }
    func isEditable(_ element: FakeElement) -> Bool { base.isEditable(element) }
    func hidden(_ element: FakeElement) -> Bool { element.attributes["hidden"] != nil }
    func visibleChildren(_ element: FakeElement) -> [FakeElement]? { nil }
    func selectedChildren(_ element: FakeElement) -> [FakeElement]? {
        element.attributes["selectedChildrenKnown"] == nil ? nil : element.children.filter { $0.attributes["selected"] != nil }
    }
    func terminalSurface(_ element: FakeElement, id: Int, clip: CGRect, focused: Bool,
                         byteBudget: Int, geometryValid: () -> Bool, valid: () -> Bool) -> TerminalViewportReader.Surface? {
        acquisitions.append(element)
        onAcquire?()
        guard let provider = providers[ObjectIdentifier(element)] else { return nil }
        let source = provider.source
        let translated = TerminalViewportReader.Source(attribute: source.attribute, parameter: source.parameter,
            bounds: { range in source.bounds(range)?.offsetBy(dx: element.frame?.minX ?? 0, dy: 0) })
        return TerminalViewportReader.surface(translated, id: id, clip: clip, focused: focused,
                                              startKnown: false, endKnown: false, byteBudget: byteBudget, geometryValid: geometryValid, valid: valid)
    }
    func read(_ window: FakeElement, focused: FakeElement, path: [FakeElement],
              currentFocus: (() -> FakeElement)? = nil, exclusions: [String] = [],
              bundleID: String? = "com.apple.Terminal") -> ScreenContext? {
        ScreenContextReader.read(window: window, focused: focused, focusPath: path, in: self,
            current: { $0 == kAXFocusedWindowAttribute ? window : (currentFocus?() ?? focused) },
            excluding: ScreenExclusions(hosts: exclusions), started: Date(),
            from: ScreenContext(appName: "Synthetic Terminal", bundleID: bundleID))
    }
}

struct TerminalCollectorTests {
    @Test func productionDispatchSeparatesTerminalAndGenericReaders() throws {
        for bundleID in HelperConfig.terminalBundleIDs.map(Optional.some) + [nil, "example.editor"] {
            let surface = FakeElement("AXTextArea", frame: CGRect(x: 0, y: 10, width: 400, height: 20))
            let window = FakeElement("AXWindow", frame: surface.frame, children: [surface])
            let tree = TerminalCollectorFixture()
            tree.providers[ObjectIdentifier(surface)] = TerminalAXFixture()
            let context = try #require(tree.read(window, focused: surface, path: [window], bundleID: bundleID))
            if let bundleID, HelperConfig.terminalBundleIDs.contains(bundleID) {
                #expect(context.json["terminalViewport"]?["caret"]?["offset"]?.integer == 7)
                #expect(context.json["renderedText"]?.string == "[Terminal surface 0]\n> hello world\nstatus bar\n")
                #expect(tree.acquisitions.count == 1 && tree.genericReads == 0)
            } else {
                #expect(context.json["terminalViewport"] == nil)
                #expect(tree.acquisitions.isEmpty && tree.genericReads > 0)
            }
        }
    }

    @Test func identicalVisibleSplitsKeepIdentityAndFocusedChildCaret() throws {
        let child = FakeElement("AXGroup")
        let left = FakeElement("AXTextArea", frame: CGRect(x: 0, y: 10, width: 400, height: 20))
        let right = FakeElement("AXTextArea", frame: CGRect(x: 400, y: 10, width: 400, height: 20), children: [child])
        let hidden = FakeElement("AXTextArea", ["hidden": "true"], frame: left.frame)
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 10, width: 800, height: 20), children: [left, hidden, right])
        let tree = TerminalCollectorFixture()
        let a = TerminalAXFixture(), b = TerminalAXFixture()
        tree.providers = [ObjectIdentifier(left): a, ObjectIdentifier(right): b]
        let context = try #require(tree.read(window, focused: child, path: [right, window]))
        let wire = context.json
        #expect(wire["terminalViewport"]?["surfaces"]?.array?.count == 2)
        #expect(wire["terminalViewport"]?["caret"]?["surface"]?.integer == 1)
        #expect(wire["terminalViewport"]?["caret"]?["offset"]?.integer == 7)
        #expect(wire["renderedText"]?.string == "[Terminal surface 0]\n> hello world\nstatus bar\n\n[Terminal surface 1]\n> hello world\nstatus bar\n")
        #expect(!tree.acquisitions.contains { $0 === hidden })
        #expect(tree.acquisitions.count == 2) // One capture of each surface.
        #expect(tree.genericReads == 0 && a.forbidden.isEmpty && b.forbidden.isEmpty)
    }

    @Test func excludedAndProtectedSubtreesNeverReachSurfaceAcquisition() {
        for excludedPage in [false, true] {
            let child = excludedPage
                ? FakeElement("AXWebArea", ["host": "private.example"])
                : FakeElement("AXTextField", [kAXSubroleAttribute: kAXSecureTextFieldSubrole as String])
            let surface = FakeElement("AXTextArea", frame: CGRect(x: 0, y: 10, width: 400, height: 20), children: [child])
            let window = FakeElement("AXWindow", frame: surface.frame, children: [surface])
            let tree = TerminalCollectorFixture()
            tree.providers[ObjectIdentifier(surface)] = TerminalAXFixture()
            let result = tree.read(window, focused: surface, path: [window], exclusions: ["private.example"])
            if excludedPage { #expect(result == nil) }
            else { #expect(result?.json["terminalViewport"]?["complete"]?.bool == false) }
            #expect(tree.acquisitions.isEmpty && tree.genericReads == 0)
        }
    }

    @Test func focusChangeDuringAcquisitionRefusesTheWholeResult() {
        let surface = FakeElement("AXTextArea", frame: CGRect(x: 0, y: 10, width: 400, height: 20))
        let other = FakeElement("AXTextArea")
        let window = FakeElement("AXWindow", frame: surface.frame, children: [surface])
        let tree = TerminalCollectorFixture()
        let provider = TerminalAXFixture()
        tree.providers[ObjectIdentifier(surface)] = provider
        var current = surface
        tree.onAcquire = { current = other }
        #expect(tree.read(window, focused: surface, path: [window], currentFocus: { current }) == nil)
        #expect(provider.reads.isEmpty && tree.genericReads == 0)
    }

    @Test func unselectedSamePositionTabIsNeverAcquired() throws {
        let selected = FakeElement("AXTextArea", ["selected": "yes"], frame: CGRect(x: 0, y: 10, width: 400, height: 20))
        let hidden = FakeElement("AXTextArea", frame: selected.frame)
        let tab = FakeElement("AXTabGroup", ["selectedChildrenKnown": "yes"], frame: selected.frame, children: [hidden, selected])
        let window = FakeElement("AXWindow", frame: selected.frame, children: [tab])
        let tree = TerminalCollectorFixture()
        tree.providers[ObjectIdentifier(selected)] = TerminalAXFixture()
        let context = try #require(tree.read(window, focused: selected, path: [tab, window]))
        #expect(context.json["terminalViewport"]?["complete"]?.bool == true)
        #expect(tree.acquisitions.count == 1 && tree.acquisitions.allSatisfy { $0 === selected })
        #expect(hidden.textReads == 0 && tree.genericReads == 0)
    }

    @Test func ancestorClipRetainsOnlyDisplayedLineAndRefusesOffscreenCaret() throws {
        let surface = FakeElement("AXTextArea", frame: CGRect(x: 0, y: 10, width: 400, height: 20))
        let clipped = FakeElement("AXGroup", frame: CGRect(x: 0, y: 20, width: 400, height: 10), children: [surface])
        let window = FakeElement("AXWindow", frame: surface.frame, children: [clipped])
        let tree = TerminalCollectorFixture()
        let provider = TerminalAXFixture()
        tree.providers[ObjectIdentifier(surface)] = provider
        let context = try #require(tree.read(window, focused: surface, path: [clipped, window]))
        #expect(context.json["renderedText"]?.string == "[Terminal surface 0]\nstatus bar\n")
        #expect(context.json["terminalViewport"]?["caret"]?["status"]?.string == "outsideViewport")
        #expect(provider.reads == [NSRange(location: 22, length: 11)])
        #expect(provider.forbidden.isEmpty && tree.genericReads == 0)
    }

}

struct TerminalSnapshotInvariantTests {
    @Test func focusedFirstSplitKeepsItsOwnCaret() throws {
        let left=FakeElement("AXTextArea", frame: CGRect(x:0,y:10,width:400,height:20))
        let right=FakeElement("AXTextArea", frame: CGRect(x:400,y:10,width:400,height:20))
        let window=FakeElement("AXWindow", frame:CGRect(x:0,y:10,width:800,height:20),children:[left,right])
        let tree=TerminalCollectorFixture()
        let a=TerminalAXFixture(), b=TerminalAXFixture()
        tree.providers=[ObjectIdentifier(left):a,ObjectIdentifier(right):b]
        let context=try #require(tree.read(window,focused:left,path:[window]))
        #expect(context.json["terminalViewport"]?["surfaces"]?.array?.count == 2)
        #expect(context.json["terminalViewport"]?["caret"]?["surface"]?.integer == 0)
        #expect(context.json["terminalViewport"]?["caret"]?["offset"]?.integer == 7)
        #expect(tree.acquisitions.count == 2)
        #expect(a.forbidden.isEmpty && b.forbidden.isEmpty)
    }
    @Test func aChangeAfterTheReadKeepsTheKeyDownText() throws {
        let surface=FakeElement("AXTextArea",frame:CGRect(x:0,y:10,width:400,height:20))
        let window=FakeElement("AXWindow",frame:surface.frame,children:[surface])
        let tree=TerminalCollectorFixture(), provider=TerminalAXFixture()
        tree.providers[ObjectIdentifier(surface)]=provider
        provider.afterRead={ provider.lines[1]="> jello world\n" }
        let context=try #require(tree.read(window,focused:surface,path:[window]))
        #expect(context.json["renderedText"]?.string == "[Terminal surface 0]\n> hello world\nstatus bar\n")
        #expect(tree.acquisitions.count == 1 && provider.reads.count == 1)
        #expect(provider.forbidden.isEmpty)
    }
    @Test func contradictoryInsertionLineCannotPublishExactCaret() throws {
        let provider=TerminalAXFixture()
        #expect(try provider.wire()["terminalViewport"]?["caret"]?["status"]?.string == "exact")
        provider.insertionLine=2
        let wire=try provider.wire()
        #expect(wire["terminalViewport"]?["caret"]?["status"]?.string != "exact")
        #expect(wire["renderedText"]?.string?.contains("> hello world") == true)
        #expect(provider.forbidden.isEmpty)
    }
    @Test func offscreenGeometryCannotPublishExactCaret() throws {
        let provider=TerminalAXFixture();let source=provider.source
        let hiddenCaret=TerminalViewportReader.Source(attribute:source.attribute,parameter:source.parameter,bounds:{ range in
            if range.length == 0 { return CGRect(x:1000,y:10,width:1,height:10) }
            return source.bounds(range)
        })
        let capture=try #require(TerminalViewportReader.surface(hiddenCaret,id:0,clip:CGRect(x:0,y:10,width:400,height:20),focused:true,startKnown:false,endKnown:false,valid:{true}))
        #expect(capture.caret["status"]?.string != "exact")
        #expect(capture.source["runs"]?.array?.first?["text"]?.string == "> hello world\nstatus bar\n")
        #expect(provider.forbidden.isEmpty)
    }
    @Test func emptyVisibleViewportPreservesKnownCaretWithoutReadingText() throws {
        var reads=0;var range=CFRange(location:0,length:0)
        let empty=try #require(AXValueCreate(.cfRange,&range))
        let source=TerminalViewportReader.Source(attribute:{ name in
            if name == kAXNumberOfCharactersAttribute || name == kAXInsertionPointLineNumberAttribute { return NSNumber(value:0) }
            if name == kAXSelectedTextRangeAttribute { return empty }
            return nil
        },parameter:{ _,_ in reads += 1;return nil },bounds:{_ in CGRect(x:10,y:10,width:1,height:10)})
        let capture=try #require(TerminalViewportReader.surface(source,id:0,clip:CGRect(x:0,y:0,width:400,height:200),focused:true,startKnown:false,endKnown:false,valid:{true}))
        #expect(capture.caret["status"]?.string == "exact")
        #expect(capture.caret["offset"]?.integer == 0)
        #expect(capture.source["selection"]?["complete"]?.bool == true)
        #expect(reads == 0)
    }
}

struct TerminalFocusedSelectionTests {
    @Test func independentlySelectedSplitsKeepFocusedSelectionInBothOrders() throws {
        for focusedFirst in [true, false] {
            let left = FakeElement("AXTextArea", frame: CGRect(x: 0, y: 10, width: 400, height: 20))
            let right = FakeElement("AXTextArea", frame: CGRect(x: 400, y: 10, width: 400, height: 20))
            let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 10, width: 800, height: 20), children: [left, right])
            let tree = TerminalCollectorFixture()
            let a = TerminalAXFixture(), b = TerminalAXFixture()
            a.selection = NSRange(location: 10, length: 5) // hello
            b.selection = NSRange(location: 16, length: 5) // world
            tree.providers = [ObjectIdentifier(left): a, ObjectIdentifier(right): b]
            let context = try #require(tree.read(window, focused: focusedFirst ? left : right, path: [window]))
            #expect(context.json["terminalViewport"]?["surfaces"]?.array?.count == 2)
            #expect(context.json["selectedText"]?.string == (focusedFirst ? "hello" : "world"))
            #expect(context.json["terminalViewport"]?["selectionComplete"]?.bool == true)
            #expect(tree.acquisitions.count == 2 && tree.genericReads == 0)
            #expect(a.forbidden.isEmpty && b.forbidden.isEmpty)
        }
    }
}


struct TerminalAcquisitionInvariantTests {
    private let partialClip = CGRect(x: 5, y: 15, width: 20, height: 10)
    private func capture(_ source: TerminalViewportReader.Source, clip: CGRect) -> TerminalViewportReader.Surface? {
        TerminalViewportReader.surface(source, id: 0, clip: clip, focused: true,
                                       startKnown: false, endKnown: false, valid: { true })
    }

    @Test func partialGlyphsReachVisibleOutputAndOnlyVisibleReads() throws {
        let provider = TerminalAXFixture()
        let result = try #require(capture(provider.source, clip: partialClip))
        #expect(result.source["runs"]?.array?.compactMap { $0["text"]?.string } == ["> h", "sta"])
        let expected = [NSRange(location: 8, length: 3), NSRange(location: 22, length: 3)]
        #expect(provider.reads == expected)
        #expect(provider.forbidden.isEmpty)
    }

    @Test func missingSubrangeGeometryRefusesBeforeTextAcquisition() {
        let provider = TerminalAXFixture(), original = provider.source
        var failedGeometry = 0
        let source = TerminalViewportReader.Source(attribute: original.attribute, parameter: original.parameter, bounds: { range in
            if range.location == 8 && range.length == 1 { failedGeometry += 1; return nil }
            return original.bounds(range)
        })
        #expect(capture(source, clip: partialClip) == nil)
        #expect(failedGeometry > 0)
        #expect(provider.reads.isEmpty && provider.forbidden.isEmpty)
    }

    @Test func nonfiniteSubrangeGeometryRefusesBeforeTextAcquisition() {
        let provider = TerminalAXFixture(), original = provider.source
        var failedGeometry = 0
        let source = TerminalViewportReader.Source(attribute: original.attribute, parameter: original.parameter, bounds: { range in
            if range.location == 8 && range.length == 1 {
                failedGeometry += 1
                return CGRect(x: CGFloat.infinity, y: 10, width: 10, height: 10)
            }
            return original.bounds(range)
        })
        #expect(capture(source, clip: partialClip) == nil)
        #expect(failedGeometry > 0)
        #expect(provider.reads.isEmpty && provider.forbidden.isEmpty)
    }

    @Test func zeroWidthVisibleLineBreakIsRetained() throws {
        let range = NSRange(location: 0, length: 1)
        let ranges = try #require(TerminalViewportReader.visibleRanges(lines: [range],
            clip: CGRect(x: 10, y: 5, width: 20, height: 5),
            bounds: { _ in CGRect(x: 10, y: 0, width: 0, height: 10) }, valid: { true }))
        var reads: [NSRange] = []
        let result = TerminalViewportReader.capture(ranges: ranges, count: 1, unitBudget: 1,
            read: { reads.append($0); return "\n" }, valid: { true })
        #expect(ranges == [range])
        #expect(result?.texts == ["\n"])
        #expect(reads == [range])
    }

    // Output or a selection change during the read leaves the text and caret as at key-down
    // (owner, 2026-10-05): a stale screen is kept, rather than none.
    @Test func outputDuringTheReadKeepsTheKeyDownText() throws {
        let provider = TerminalAXFixture(), original = provider.source
        var changed = false
        let source = TerminalViewportReader.Source(attribute: { name in
            if name == kAXInsertionPointLineNumberAttribute { provider.lines[3] += "x"; changed = true }
            return original.attribute(name)
        }, parameter: original.parameter, bounds: original.bounds)
        let result = try #require(capture(source, clip: CGRect(x: 0, y: 10, width: 400, height: 20)))
        #expect(result.source["runs"]?.array?.compactMap { $0["text"]?.string }.joined() == "> hello world\nstatus bar\n")
        #expect(changed && provider.reads.count == 1)
        #expect(provider.forbidden.isEmpty)
    }

    @Test func aSelectionChangeDuringTheReadKeepsTheKeyDownCaret() throws {
        let provider = TerminalAXFixture(), original = provider.source
        var changed = false
        let source = TerminalViewportReader.Source(attribute: { name in
            if name == kAXInsertionPointLineNumberAttribute { provider.selection = NSRange(location: 16, length: 0); changed = true }
            return original.attribute(name)
        }, parameter: original.parameter, bounds: original.bounds)
        let result = try #require(capture(source, clip: CGRect(x: 0, y: 10, width: 400, height: 20)))
        #expect(result.caret["offset"]?.integer == 7)
        #expect(changed && provider.reads.count == 1)
        #expect(provider.forbidden.isEmpty)
    }
}
