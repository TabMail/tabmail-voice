import Foundation
import ApplicationServices
import VoiceHelperSupport
import Testing
@testable import VoiceMacOSKit

// Synthetic ASCII text; endpoint boxes model iTermTextViewAccessibilityHelper.boundsForRange.
// Physical grid is wider than these rows, so no right-margin wrapping is involved.
private final class EndpointBoxProvider {
    let text: NSString
    let ranges: [NSRange]
    let allowed: [NSRange]
    var lineQueriesAvailable = true
    var reads: [NSRange] = []
    var forbidden: [NSRange] = []
    init(lines: [String], allowed: [NSRange]) {
        text = lines.joined() as NSString
        var start = 0
        ranges = lines.map { line in
            let length = (line as NSString).length
            defer { start += length }
            return NSRange(location: start, length: length)
        }
        self.allowed = allowed
    }
    func line(_ offset: Int) -> Int? {
        ranges.firstIndex { $0.location <= offset && offset < NSMaxRange($0) }
    }
    var source: TerminalViewportReader.Source {
        TerminalViewportReader.Source(attribute: { [self] name in
            if name == kAXNumberOfCharactersAttribute { return NSNumber(value: text.length) }
            if name == kAXSelectedTextRangeAttribute {
                var range = CFRange(location: 0, length: 0)
                return AXValueCreate(.cfRange, &range)
            }
            if name == kAXInsertionPointLineNumberAttribute { return NSNumber(value: 0) }
            return nil
        }, parameter: { [self] name, value in
            if name == kAXLineForIndexParameterizedAttribute {
                guard lineQueriesAvailable else { return nil }
                guard let index = value as? NSNumber, let line = line(index.intValue) else { return nil }
                return NSNumber(value: line)
            }
            guard name == kAXStringForRangeParameterizedAttribute,
                  CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
            var range = CFRange()
            guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
            let requested = NSRange(location: range.location, length: range.length)
            reads.append(requested)
            guard allowed.contains(where: { requested.location >= $0.location && NSMaxRange(requested) <= NSMaxRange($0) }) else {
                forbidden.append(requested); return nil
            }
            return text.substring(with: requested) as NSString
        }, bounds: { [self] range in
            let last = range.location + max(0, range.length - 1)
            guard let firstLine = line(range.location), let lastLine = line(last) else { return nil }
            let startX = range.location - ranges[firstLine].location
            let endX = last - ranges[lastLine].location + (range.length == 0 ? 0 : 1)
            return CGRect(x: min(startX, endX) * 10, y: firstLine * 10,
                          width: abs(startX - endX) * 10, height: (lastLine - firstLine + 1) * 10)
        })
    }
}

struct TerminalEndpointBoundsTests {
    @Test(arguments: [true, false]) func hiddenInteriorColumnsAreNotAcquiredFromContainedEndpointBoxes(lineMetadataAvailable: Bool) throws {
        let allowed = [NSRange(location: 0, length: 2), NSRange(location: 5, length: 2), NSRange(location: 10, length: 2)]
        let provider = EndpointBoxProvider(lines: ["abXY\n", "cdXY\n", "ef"], allowed: allowed)
        provider.lineQueriesAvailable = lineMetadataAvailable
        let result = TerminalViewportReader.surface(provider.source, id: 0,
            clip: CGRect(x: 0, y: 0, width: 20, height: 30), focused: true,
            startKnown: false, endKnown: false, valid: { true })
        #expect(provider.forbidden.isEmpty)
        let captured = try #require(result)
        #expect(captured.source["runs"]?.array?.compactMap { $0["text"]?.string } == ["ab", "cd", "ef"])
        #expect(provider.reads == allowed + allowed)
        var context = ScreenContext(appName: "Synthetic Terminal", bundleID: "example.terminal")
        try TerminalViewportReader.finish(["complete": true, "focusedSurface": 0,
            "caret": captured.caret, "surfaces": .array([captured.source])], into: &context)
        #expect(context.json["renderedText"]?.string?.contains("XY") == false)
        #expect(context.json["renderedText"]?.string?.contains("ef") == true)
    }
    @Test(arguments: [true, false]) func visibleInteriorColumnsAreKeptWhenEndpointBoxIsOutsideClip(lineMetadataAvailable: Bool) throws {
        let allowed = [NSRange(location: 2, length: 1), NSRange(location: 7, length: 1)]
        let provider = EndpointBoxProvider(lines: ["abCz\n", "xyDz\n", "q"], allowed: allowed)
        provider.lineQueriesAvailable = lineMetadataAvailable
        let captured = try #require(TerminalViewportReader.surface(provider.source, id: 0,
            clip: CGRect(x: 20, y: 0, width: 10, height: 30), focused: true,
            startKnown: false, endKnown: false, valid: { true }))
        #expect(captured.source["runs"]?.array?.compactMap { $0["text"]?.string } == ["C", "D"])
        #expect(provider.reads == allowed + allowed)
        #expect(provider.forbidden.isEmpty)
    }
}
