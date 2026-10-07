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
    /// must stay inside a planned visible interval. The text is read once: output
    /// arriving meanwhile leaves a slightly stale capture, which is kept (owner,
    /// 2026-10-05: the screen as at key-down, rather than no screen at all).
    static func capture(ranges: [NSRange], count: Int, unitBudget: Int,
                        read: (NSRange) -> NSString?, valid: () -> Bool) -> Capture? {
        // Counts and lengths only, never text.
        func refused(_ reason: String) -> Capture? {
            HelperLog.debug("TerminalViewport: capture refused \(reason) ranges=\(ranges.count) count=\(count) budget=\(unitBudget)")
            return nil
        }
        guard count >= 0, unitBudget >= 0, ranges.allSatisfy({ $0.location >= 0 && $0.length >= 0 && $0.location <= Int.max - $0.length })
        else { return refused("negative") }
        // Which spans may be read is the shared core's: in order, apart, inside the document and within
        // the budget (ADR-DESK-054).
        let spans = JSON.array(ranges.map { [.number(Double($0.location)), .number(Double(NSMaxRange($0)))] })
        guard let plan = try? project(["collect": ["plan": ["count": .number(Double(count)), "spans": spans,
                                                            "bytes": .number(Double(unitBudget))]]]),
              plan["admit"] == .bool(true) else { return refused("plan") }
        var texts: [String] = []
        for (index, range) in ranges.enumerated() {
            guard valid() else { return refused("invalid before run \(index)") }
            guard let text = read(range) else { return refused("no text for run \(index) length=\(range.length)") }
            guard text.length == range.length else { return refused("run \(index) asked=\(range.length) got=\(text.length)") }
            let converted = text as String
            let units = Array(converted.utf16)
            guard units.count == text.length, units.enumerated().allSatisfy({ text.character(at: $0.offset) == $0.element }) else { return refused("run \(index) conversion") }
            texts.append(converted)
        }
        guard valid() else { return refused("invalid after read") }
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
        // Geometry acquires no text. Repeat the complete focus/privacy validation at the
        // text acquisition and final acceptance boundaries instead of on every geometry query.
        let diagnosticStart = Date()
        func metadataValid() -> Bool { geometryValid() }
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
              let limits = try? project(["limits": true]), let byteLimit = limits["bytes"]?.integer else { return nil }
        let selectionSnapshot = selection()
        let byteBudget = min(byteLimit, byteBudget)
        var ranges = [NSRange(location: 0, length: 0)]
        var texts = [""]
        if countSnapshot > 0 {
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
            guard let planned = plan() else { return nil }
            let read: (NSRange) -> NSString? = { requested in
                var range = CFRange(location: requested.location, length: requested.length)
                guard let parameter = AXValueCreate(.cfRange, &range), valid() else { return nil }
                return source.parameter(kAXStringForRangeParameterizedAttribute as String, parameter) as? NSString
            }
            // A UTF-16 unit is at least one UTF-8 byte, so no more units are read than the budget has
            // bytes; the shared core checks the bytes.
            diagnosticStage = "bounded-text"
            guard let captured = capture(ranges: planned, count: countSnapshot, unitBudget: byteBudget,
                                         read: read, valid: valid) else { return nil }
            ranges = captured.ranges
            texts = captured.texts
        }
        diagnosticStage = "selection-caret"
        // The caret, when the field has one and no selection: where it is and where it is drawn. iTerm2
        // can report an insertion line other than its offset's, and then where it is drawn is unknown.
        var caret: JSON = .null
        if focused, let selected = selectionSnapshot, selected.length == 0 {
            let insertionLine = integer(source.attribute(kAXInsertionPointLineNumberAttribute))
            let line = countSnapshot == 0 ? 0 : integer(parameter(kAXLineForIndexParameterizedAttribute as String, selected.location as CFNumber))
            let drawn = insertionLine != nil && insertionLine == line ? bounds(selected) : nil
            let frame: JSON = drawn.map { .array([$0.minX, $0.minY, $0.width, $0.height].map { .number(Double($0)) }) } ?? .null
            // An empty field's caret is offered only where it is drawn.
            if countSnapshot > 0 || (selected.location == 0 && drawn != nil) {
                caret = ["offset": .number(Double(selected.location)), "frame": frame]
            }
        }
        let request: JSON = ["surface": [
            "id": .number(Double(id)), "frame": .array([clip.minX, clip.minY, clip.width, clip.height].map { .number(Double($0)) }),
            "offsetUnit": "utf16", "count": .number(Double(countSnapshot)), "startKnown": .bool(startKnown), "endKnown": .bool(endKnown),
            "bytes": .number(Double(byteBudget)), "spans": .array(ranges.map { [.number(Double($0.location)), .number(Double(NSMaxRange($0)))] }),
            "texts": .array(texts.map(JSON.string)),
            "selections": selectionSnapshot.map { [[.number(Double($0.location)), .number(Double(NSMaxRange($0)))]] } ?? .null,
            "caret": caret,
        ]]
        guard valid(), let built = try? project(request), let surface = built["surface"], let caret = built["caret"] else { return nil }
        diagnosticSucceeded = true
        return Surface(source: surface, caret: caret)
    }
}

extension TerminalViewportReader {
    /// Keeps the viewport source for the reply, where the shared core projects and redacts it once
    /// (`ScreenContext.json`); nothing else of the context is sent for a terminal.
    static func finish(_ source: JSON, into context: inout ScreenContext) {
        context.terminalSource = source
        context.terminalProgram = nil
        context.textBeforeCaret = ""
        context.selectedText = ""
        context.textAfterCaret = ""
        context.blocks = []
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
        // What is gathered, how much, and what the viewport says are the shared core's (`collect`).
        guard let window, let windowFrame = tree.frame(of: window), windowFrame.width > 0, windowFrame.height > 0,
              var collected = try? project(["collect": ["start": true]]) else { return nil }
        diagnosticStage = "privacy-census"
        // Complete metadata-only privacy census before any terminal source read.
        guard case .none = ScreenContextReader.lookForExcludedPage(in: window, tree, excluding: exclusions,
                    within: .infinity, since: started) else { return nil }
        // No deadline: the read runs while the user speaks, and the app decides how long to wait
        // for it when it sends (owner, 2026-10-05). Only the window and focus must stay the same.
        func valid() -> Bool {
            guard let currentWindow = current(kAXFocusedWindowAttribute as String), tree.isSame(currentWindow, window) else { return false }
            let currentFocus = current(kAXFocusedUIElementAttribute as String)
            if let focused, let currentFocus { return tree.isSame(focused, currentFocus) }
            return focused == nil && currentFocus == nil
        }
        // A surface's text takes in everything under it: the shared census with `protect`, which
        // a password field or an excluded page anywhere in it, or a look cut short, refuses.
        func readable(_ element: Tree.Element) -> Bool {
            ScreenContextReader.lookForExcludedPage(in: element, tree, excluding: exclusions, protect: true, valid: valid) == .none && valid()
        }
        var stack: [(Tree.Element, CGRect)] = [(window, windowFrame)]
        var seen: [Tree.Element] = []
        var surfaceElements: [Tree.Element] = []
        var complete = true
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
                if clip.isNull || clip.isEmpty { continue }
            }
            if role == "AXTextArea" || role == "AXTextField" {
                guard let next = try? project(["collect": ["state": collected, "next": true]]), let id = next["id"]?.integer,
                      let bytes = next["bytes"]?.integer else { return nil }
                guard next["read"] == .bool(true) else { complete = false; break }
                guard readable(element) else { complete = false; continue }
                let ownsFocus = focused.map { tree.isSame($0, element) } == true || focusPath.contains { tree.isSame($0, element) }
                guard let captured = tree.terminalSurface(element, id: id, clip: clip, focused: ownsFocus, byteBudget: bytes,
                                             geometryValid: { true }, valid: valid) else { complete = false; continue }
                guard let taken = try? project(["collect": ["state": collected, "take": ["surface": captured.source, "caret": captured.caret],
                                                            "focused": .bool(ownsFocus)]]) else { return nil }
                collected = taken
                surfaceElements.append(element)
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
        // Privacy is checked again at the end; the text is not read again (see `capture`).
        guard valid(), case .none = ScreenContextReader.lookForExcludedPage(in: window, tree, excluding: exclusions,
                    within: .infinity, since: started) else { return nil }
        context.nodesVisited = seen.count
        context.windowTitle = tree.sourceString(window, kAXTitleAttribute)
        guard valid(), surfaceElements.allSatisfy({ readable($0) }) else { return nil }
        guard let viewport = try? project(["collect": ["state": collected, "finish": ["complete": .bool(complete)]]]) else { return nil }
        finish(viewport, into: &context)
        context.seconds = Date().timeIntervalSince(started)
        diagnosticSucceeded = true
        HelperLog.debug("TerminalViewport: result surfaces=\(surfaceElements.count) complete=\(complete) nodes=\(seen.count) elapsedMs=\(Int(context.seconds * 1000))")
        return context
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
