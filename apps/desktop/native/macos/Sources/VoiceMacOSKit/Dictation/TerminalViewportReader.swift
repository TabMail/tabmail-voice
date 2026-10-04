// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import ApplicationServices
import Foundation
import VoiceHelperSupport

/// Native AX acquisition only. The shared core owns all text projection,
/// recognition-edge policy, selection safety, redaction and rendering.
enum TerminalViewportReader {
    struct Capture {
        let ranges: [NSRange]
        let texts: [String]
    }

    /// No whole-value or selected-text callback exists: every text-bearing call
    /// must stay inside a proven visible interval. Repeat reads catch same-length
    /// mutations which count/selection equality cannot detect.
    static func capture(ranges: [NSRange], count: Int, unitBudget: Int,
                        read: (NSRange) -> NSString?, valid: () -> Bool) -> Capture? {
        guard count >= 0, unitBudget >= 0 else { return nil }
        var previous = 0
        var units = 0
        for range in ranges {
            guard range.location >= previous, range.length >= 0, range.location <= count,
                  range.length <= count - range.location, range.length <= unitBudget - units else { return nil }
            units += range.length
            previous = range.location + range.length
        }
        var texts: [String] = []
        for range in ranges {
            guard valid(), let text = read(range), text.length == range.length else { return nil }
            let converted = text as String
            let units = Array(converted.utf16)
            guard units.count == text.length, units.enumerated().allSatisfy({ text.character(at: $0.offset) == $0.element }) else { return nil }
            texts.append(converted)
        }
        for (range, text) in zip(ranges, texts) {
            let units = Array(text.utf16)
            guard valid(), let repeated = read(range), repeated.length == units.count,
                  units.enumerated().allSatisfy({ repeated.character(at: $0.offset) == $0.element }) else { return nil }
        }
        guard valid() else { return nil }
        return Capture(ranges: ranges, texts: texts)
    }

    /// Geometry-only visibility planning. A contained single-line range is the
    /// fast path; clipped or multiline ranges are subdivided before any text read.
    /// Missing geometry refuses the plan rather than reading a bounding interval
    /// that could contain scrollback or horizontally hidden text.
    static func visibleRanges(lines: [NSRange], clip: CGRect,
                              bounds: (NSRange) -> CGRect?, isSingleLine: (NSRange) -> Bool = { _ in true }, valid: () -> Bool) -> [NSRange]? {
        guard clip.width > 0, clip.height > 0 else { return nil }
        var result: [NSRange] = []
        func append(_ range: NSRange) {
            if let last = result.last, NSMaxRange(last) == range.location {
                result[result.count - 1].length += range.length
            } else { result.append(range) }
        }
        func visit(_ range: NSRange) -> Bool {
            guard valid(), let frame = bounds(range), frame.minX.isFinite, frame.minY.isFinite,
                  frame.width.isFinite, frame.height.isFinite, frame.width >= 0, frame.height >= 0 else { return false }
            if frame.maxY <= clip.minY || frame.minY >= clip.maxY { return true }
            // A contained range proves visibility for all its units. Subdivide only
            // at clipping edges instead of issuing one AX request for every glyph.
            // Multiline providers can report endpoint-only horizontal bounds.
            // Ask for line identity only when a box can prove acceptance/pruning.
            let horizontal = frame.width == 0 ? frame.minX >= clip.minX && frame.minX <= clip.maxX : frame.maxX > clip.minX && frame.minX < clip.maxX
            if range.length <= 1 {
                if horizontal { append(range) }
                return true
            }
            if frame.width > 0 {
                if clip.contains(frame), frame.height > 0, isSingleLine(range) { append(range); return true }
                if !horizontal, isSingleLine(range) { return true }
            }
            let left = range.length / 2
            return visit(NSRange(location: range.location, length: left)) &&
                visit(NSRange(location: range.location + left, length: range.length - left))
        }
        for line in lines {
            guard line.location >= 0, line.length >= 0, line.location <= Int.max - line.length,
                  visit(line) else { return nil }
        }
        return result
    }
}

extension TerminalViewportReader {
    struct Surface {
        let source: JSON
        let caret: JSON
    }

    static func project(_ request: JSON) throws -> JSON {
        let result = try Redactor.request(JSONEncoder().encode(request), operation: .viewport)
        return try JSONDecoder().decode(JSON.self, from: result)
    }

    /// Raw AX calls are injectable so provider contracts exercise the same native
    /// conversion, acquisition and projection path used by the installed helper.
    struct Source {
        let attribute: (String) -> CFTypeRef?
        let parameter: (String, CFTypeRef) -> CFTypeRef?
        let bounds: (CFRange) -> CGRect?
    }

    /// The caller establishes content clipping, privacy and authoritative focus
    /// identity. AXFocused and AXVisibleCharacterRange are deliberately unused:
    /// iTerm can report YES/all history for those attributes.
    static func surface(_ element: AXUIElement, id: Int, clip: CGRect, focused: Bool,
                        startKnown: Bool, endKnown: Bool, byteBudget: Int = Int.max, geometryValid: () -> Bool = { true }, valid: () -> Bool) -> Surface? {
        surface(Source(attribute: { CaretLocator.attribute(element, $0) },
                       parameter: { CaretLocator.parameterized(element, $0, $1) },
                       bounds: { CaretLocator.bounds(of: $0, in: element) }),
                id: id, clip: clip, focused: focused, startKnown: startKnown,
                endKnown: endKnown, byteBudget: byteBudget, geometryValid: geometryValid, valid: valid)
    }

    static func surface(_ source: Source, id: Int, clip: CGRect, focused: Bool,
                        startKnown: Bool, endKnown: Bool, byteBudget: Int = Int.max, geometryValid: () -> Bool = { true }, valid: () -> Bool) -> Surface? {
        // Geometry acquires no text. Bound its work by the deadline; repeat the
        // complete focus/frame/privacy validation at the text acquisition and
        // final acceptance boundaries instead of on every geometry query.
        let diagnosticStart = Date()
        func metadataValid() -> Bool {
            Date().timeIntervalSince(diagnosticStart) <= HelperConfig.contextTimeBudget && geometryValid()
        }
        var diagnosticStage = "count"
        var diagnosticSucceeded = false
        defer {
            if !diagnosticSucceeded {
                HelperLog.debug("TerminalViewport: surface refused stage=\(diagnosticStage) focused=\(focused) elapsedMs=\(Int(Date().timeIntervalSince(diagnosticStart) * 1000))")
            }
        }
        func integer(_ value: CFTypeRef?) -> Int? {
            guard let value, CFGetTypeID(value) != CFBooleanGetTypeID(), let number = value as? NSNumber,
                  let result = Int(exactly: number.doubleValue), result >= 0 else { return nil }
            return result
        }
        func count() -> Int? { integer(source.attribute(kAXNumberOfCharactersAttribute)) }
        func range(_ value: CFTypeRef?) -> NSRange? {
            guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
            var range = CFRange()
            guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0,
                  range.location <= Int.max - range.length else { return nil }
            return NSRange(location: range.location, length: range.length)
        }
        func selection() -> NSRange? { range(source.attribute(kAXSelectedTextRangeAttribute)) }
        func parameter(_ name: String, _ value: CFTypeRef) -> CFTypeRef? {
            guard metadataValid() else { return nil }
            return source.parameter(name, value)
        }
        func bounds(_ range: NSRange) -> CGRect? {
            guard metadataValid() else { return nil }
            return source.bounds(CFRange(location: range.location, length: range.length))
        }
        guard valid(), let countSnapshot = count(),
              let limits = try? project(["limits": true]), let byteLimit = limits["bytes"]?.integer,
              let runLimit = limits["runs"]?.integer else { return nil }
        let selectionSnapshot = selection()
        if countSnapshot == 0 {
            let empty = NSRange(location: 0, length: 0)
            var caret: JSON = ["status": "unavailable"]
            if focused, selectionSnapshot == empty,
               integer(source.attribute(kAXInsertionPointLineNumberAttribute)) == 0,
               let frame = bounds(empty), frame.minX >= clip.minX, frame.minX <= clip.maxX,
               frame.maxY > clip.minY, frame.minY < clip.maxY {
                caret = ["status": "exact", "surface": .number(Double(id)), "run": 0, "offset": 0]
            }
            guard valid(), count() == 0, selection() == selectionSnapshot else { return nil }
            diagnosticSucceeded = true
            return Surface(source: ["id": .number(Double(id)),
                "frame": .array([clip.minX, clip.minY, clip.width, clip.height].map { .number(Double($0)) }),
                "runs": [["id": 0, "text": "", "connected": false, "startKnown": .bool(startKnown), "endKnown": .bool(endKnown)]],
                "selection": ["complete": .bool(selectionSnapshot == empty), "ranges": []]], caret: caret)
        }
        diagnosticStage = "visible-geometry"
        let lines = [NSRange(location: 0, length: countSnapshot)]
        func plan() -> [NSRange]? {
            var lineCache: [Int: Int] = [:]
            func line(_ index: Int) -> Int? {
                if let cached = lineCache[index] { return cached }
                let result = integer(parameter(kAXLineForIndexParameterizedAttribute as String, index as CFNumber))
                lineCache[index] = result
                return result
            }
            func singleLine(_ range: NSRange) -> Bool {
                guard let first = line(range.location), let last = line(NSMaxRange(range) - 1) else { return false }
                return first == last
            }
            return visibleRanges(lines: lines, clip: clip, bounds: bounds, isSingleLine: singleLine, valid: metadataValid)
        }
        guard let ranges = plan(), ranges.count <= runLimit else { return nil }
        let read: (NSRange) -> NSString? = { requested in
            var range = CFRange(location: requested.location, length: requested.length)
            guard let parameter = AXValueCreate(.cfRange, &range), valid() else { return nil }
            return source.parameter(kAXStringForRangeParameterizedAttribute as String, parameter) as? NSString
        }
        // Three UTF-8 bytes per UTF-16 unit is the maximum conversion expansion.
        diagnosticStage = "bounded-text"
        guard let captured = capture(ranges: ranges, count: countSnapshot, unitBudget: min(byteLimit, byteBudget) / 3,
                                     read: read, valid: { valid() && count() == countSnapshot && selection() == selectionSnapshot }),
              plan() == ranges else { return nil }
        diagnosticStage = "selection-caret"
        var runs: [JSON] = []
        var selections: [JSON] = []
        var selectedUnits = 0
        var caret: JSON = ["status": "unavailable"]
        if focused, let selected = selectionSnapshot, selected.length == 0 { caret = ["status": "outsideViewport"] }
        for (index, interval) in ranges.enumerated() {
            runs.append(["id": .number(Double(index)), "text": .string(captured.texts[index]),
                         "connected": .bool(index > 0 && NSMaxRange(ranges[index - 1]) == interval.location),
                         "startKnown": .bool(startKnown && interval.location == 0),
                         "endKnown": .bool(endKnown && NSMaxRange(interval) == countSnapshot)])
            if let selected = selectionSnapshot, selected.length > 0 {
                let intersection = NSIntersectionRange(selected, interval)
                if intersection.length > 0 {
                    selectedUnits += intersection.length
                    selections.append(["run": .number(Double(index)), "start": .number(Double(intersection.location - interval.location)),
                                       "end": .number(Double(NSMaxRange(intersection) - interval.location))])
                }
            }
            if focused, let selected = selectionSnapshot, selected.length == 0,
               selected.location >= interval.location, selected.location <= NSMaxRange(interval),
               let insertionLine = integer(source.attribute(kAXInsertionPointLineNumberAttribute)),
               let nativeLine = integer(parameter(kAXLineForIndexParameterizedAttribute as String, selected.location as CFNumber)),
               insertionLine == nativeLine, let position = bounds(selected),
               position.minX >= clip.minX, position.minX <= clip.maxX,
               position.maxY > clip.minY, position.minY < clip.maxY {
                caret = ["status": "exact", "surface": .number(Double(id)), "run": .number(Double(index)),
                         "offset": .number(Double(selected.location - interval.location))]
            }
        }
        guard valid(), count() == countSnapshot, selection() == selectionSnapshot else { return nil }
        diagnosticSucceeded = true
        let completeSelection = selectionSnapshot.map { NSMaxRange($0) <= countSnapshot && selectedUnits == $0.length } ?? false
        return Surface(source: ["id": .number(Double(id)), "frame": .array([clip.minX, clip.minY, clip.width, clip.height].map { .number(Double($0)) }),
                                "runs": .array(runs), "selection": ["complete": .bool(completeSelection), "ranges": .array(selections)]], caret: caret)
    }
}

extension TerminalViewportReader {
    /// Projects source exactly once, then transfers only safe output to the
    /// helper's existing screen wire. Any selection refusal disables Edit.
    static func finish(_ source: JSON, into context: inout ScreenContext) throws {
        let output = try project(source)
        guard let selected = output["selectedText"]?.string,
              let selectionComplete = output["selectionComplete"]?.bool,
              let complete = output["complete"]?.bool,
              output["renderedText"]?.string != nil else { throw Redactor.Failure.refused }
        context.terminalViewport = output
        context.terminalProgram = nil
        context.textBeforeCaret = ""
        context.textAfterCaret = ""
        context.selectedText = selected
        context.selectionUnavailable = !selectionComplete
        context.blocks = []
        if !complete { context.stoppedEarly = "terminal viewport incomplete" }
    }

    /// Metadata-only approval of an aggregate source, including secure descendants.
    /// Cycles and oversized/incomplete scans refuse under the same node/deadline budget.
    static func readableSubtree<Node>(_ root: Node, limit: Int, valid: () -> Bool,
                                      protected: (Node) -> Bool, children: (Node) -> [Node]) -> Bool {
        var stack = [root]
        var visited = 0
        while let node = stack.popLast() {
            guard valid(), visited < limit, !protected(node) else { return false }
            visited += 1
            let descendants = children(node)
            guard descendants.count <= limit - visited - stack.count else { return false }
            stack.append(contentsOf: descendants)
        }
        return valid()
    }

    /// Terminal-specific window traversal. No generic field/caret reader runs on
    /// this path, so its whole-value and recognition-halo probes cannot fire.
    static func read<Tree: TerminalTree>(window: Tree.Element?, focused: Tree.Element?,
                     focusPath: [Tree.Element], in tree: Tree, current: (String) -> Tree.Element?,
                     excluding exclusions: ScreenExclusions, started: Date, from start: ScreenContext) -> ScreenContext? {
        var context = start
        var diagnosticStage = "window"
        var diagnosticSucceeded = false
        defer {
            if !diagnosticSucceeded {
                HelperLog.debug("TerminalViewport: collector refused stage=\(diagnosticStage) elapsedMs=\(Int(Date().timeIntervalSince(started) * 1000))")
            }
        }
        guard let window, let windowFrame = tree.frame(of: window), windowFrame.width > 0, windowFrame.height > 0,
              let limits = try? project(["limits": true]), let byteLimit = limits["bytes"]?.integer,
              let surfaceLimit = limits["surfaces"]?.integer else { return nil }
        diagnosticStage = "privacy-census"
        // Complete metadata-only privacy census before any terminal source read.
        guard case .none = ScreenContextReader.lookForExcludedPage(in: window, tree, excluding: exclusions,
                    within: HelperConfig.contextTimeBudget, since: started) else { return nil }
        func valid() -> Bool {
            guard Date().timeIntervalSince(started) <= HelperConfig.contextTimeBudget,
                  let currentWindow = current(kAXFocusedWindowAttribute as String), tree.isSame(currentWindow, window),
                  tree.frame(of: window) == windowFrame else { return false }
            let currentFocus = current(kAXFocusedUIElementAttribute as String)
            if let focused, let currentFocus { return tree.isSame(focused, currentFocus) }
            return focused == nil && currentFocus == nil
        }
        func readable(_ element: Tree.Element) -> Bool {
            readableSubtree(element, limit: HelperConfig.contextNodeBudget, valid: valid,
                protected: { node in
                    ScreenContextReader.isPasswordField(node, in: tree) ||
                    (tree.string(node, kAXRoleAttribute) == "AXWebArea" && exclusions.excludes(tree.page(of: node)))
                }, children: { tree.children(of: $0) })
        }
        var stack: [(Tree.Element, CGRect)] = [(window, windowFrame)]
        var seen: [Tree.Element] = []
        var surfaces: [JSON] = []
        var checks: [(Tree.Element, CGRect)] = []
        var verification: [(Tree.Element, Int, CGRect, Bool, Surface)] = []
        var focusedID: JSON = .null
        var caret: JSON = ["status": "unavailable"]
        var complete = true
        var remaining = byteLimit
        diagnosticStage = "traversal"
        while let (element, inheritedClip) = stack.popLast() {
            guard valid(), seen.count < HelperConfig.contextNodeBudget else { complete = false; break }
            if seen.contains(where: { tree.isSame($0, element) }) { continue }
            seen.append(element)
            if tree.hidden(element) { continue }
            if ScreenContextReader.isPasswordField(element, in: tree) { complete = false; continue }
            let role = tree.string(element, kAXRoleAttribute) ?? ""
            var clip = inheritedClip
            if let frame = tree.frame(of: element), frame.width > 0, frame.height > 0 {
                clip = clip.intersection(frame)
                checks.append((element, frame))
                if clip.isNull || clip.isEmpty { continue }
            }
            if role == "AXTextArea" || role == "AXTextField" {
                guard surfaces.count < surfaceLimit, remaining > 0 else { complete = false; break }
                guard readable(element) else { complete = false; continue }
                let id = surfaces.count
                let ownsFocus = focused.map { tree.isSame($0, element) } == true || focusPath.contains { tree.isSame($0, element) }
                guard let captured = tree.terminalSurface(element, id: id, clip: clip, focused: ownsFocus, byteBudget: remaining,
                                             geometryValid: { Date().timeIntervalSince(started) <= HelperConfig.contextTimeBudget },
                                             valid: { valid() && checks.allSatisfy { tree.frame(of: $0.0) == $0.1 } }) else { complete = false; continue }
                surfaces.append(captured.source)
                verification.append((element, id, clip, ownsFocus, captured))
                let bytes = captured.source["runs"]?.array?.reduce(0) { $0 + ($1["text"]?.string?.utf8.count ?? 0) } ?? 0
                guard bytes <= remaining else { return nil }
                remaining -= bytes
                if ownsFocus { focusedID = .number(Double(id)); caret = captured.caret }
                continue
            }
            // Tab containers must identify their visible/selected children;
            // same-position hidden tabs cannot be identified by geometry alone.
            let children: [Tree.Element]
            if let visible = tree.visibleChildren(element) { children = visible }
            else if role == "AXTabGroup" {
                guard let selected = tree.selectedChildren(element) else { complete = false; continue }
                children = selected
            } else { children = tree.children(of: element) }
            stack.append(contentsOf: children.reversed().map { ($0, clip) })
        }
        diagnosticStage = "final-validation"
        guard valid(), checks.allSatisfy({ tree.frame(of: $0.0) == $0.1 }),
              case .none = ScreenContextReader.lookForExcludedPage(in: window, tree, excluding: exclusions,
                    within: HelperConfig.contextTimeBudget, since: started) else { return nil }
        for (element, id, clip, ownsFocus, original) in verification {
            guard readable(element), let repeated = tree.terminalSurface(element, id: id, clip: clip, focused: ownsFocus, byteBudget: byteLimit,
                                         geometryValid: { Date().timeIntervalSince(started) <= HelperConfig.contextTimeBudget },
                                         valid: { valid() && checks.allSatisfy { tree.frame(of: $0.0) == $0.1 } }),
                  repeated.source == original.source, repeated.caret == original.caret else { return nil }
        }
        context.nodesVisited = seen.count
        context.windowTitle = tree.sourceString(window, kAXTitleAttribute)
        guard valid(), checks.allSatisfy({ tree.frame(of: $0.0) == $0.1 }),
              verification.allSatisfy({ readable($0.0) }) else { return nil }
        do {
            try finish(["surfaces": .array(surfaces), "focusedSurface": focusedID, "caret": caret,
                        "complete": .bool(complete && !surfaces.isEmpty)], into: &context)
            context.seconds = Date().timeIntervalSince(started)
            diagnosticSucceeded = true
            HelperLog.debug("TerminalViewport: result surfaces=\(surfaces.count) complete=\(complete) nodes=\(seen.count) elapsedMs=\(Int(context.seconds * 1000))")
            return context
        } catch { return nil }
    }
}

/// The collector uses native identity/metadata and the same surface acquisition
/// entry point in production and provider tests. Text projection stays in Rust.
protocol TerminalTree: ScreenTree {
    func hidden(_ element: Element) -> Bool
    func visibleChildren(_ element: Element) -> [Element]?
    func selectedChildren(_ element: Element) -> [Element]?
    func terminalSurface(_ element: Element, id: Int, clip: CGRect, focused: Bool,
                         byteBudget: Int, geometryValid: () -> Bool, valid: () -> Bool) -> TerminalViewportReader.Surface?
}

extension LiveScreenTree: TerminalTree {
    func hidden(_ element: AXUIElement) -> Bool {
        (CaretLocator.attribute(element, "AXHidden") as? NSNumber)?.boolValue == true
    }
    func visibleChildren(_ element: AXUIElement) -> [AXUIElement]? {
        CaretLocator.attribute(element, "AXVisibleChildren") as? [AXUIElement]
    }
    func selectedChildren(_ element: AXUIElement) -> [AXUIElement]? {
        CaretLocator.attribute(element, kAXSelectedChildrenAttribute) as? [AXUIElement]
    }
    func terminalSurface(_ element: AXUIElement, id: Int, clip: CGRect, focused: Bool,
                         byteBudget: Int, geometryValid: () -> Bool, valid: () -> Bool) -> TerminalViewportReader.Surface? {
        TerminalViewportReader.surface(element, id: id, clip: clip, focused: focused,
                                       startKnown: false, endKnown: false, byteBudget: byteBudget, geometryValid: geometryValid, valid: valid)
    }
}
