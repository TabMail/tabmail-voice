// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Foundation

/// Reads a `ScreenContext` from an app through Accessibility. Blocking: call off the main thread.
enum ScreenContextReader {
    static func read(pid: pid_t, appName: String, bundleID: String?) -> ScreenContext {
        let started = Date()
        var context = ScreenContext(appName: appName, bundleID: bundleID)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, DictationConfig.contextLookupTimeout)

        let focused = CaretLocator.attribute(app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
        context.focusedRole = focused.flatMap { string($0, kAXRoleAttribute) }
        // In a tmux terminal the active pane is read from tmux: the terminal's own text is every
        // pane side by side, and its caret index drifts (iTerm2 drops trailing spaces).
        let isTerminal = bundleID.map(DictationConfig.terminalBundleIDs.contains) ?? false
        let paneRead = isTerminal && readTmuxPane(into: &context)
        if let focused, !paneRead { readCaret(of: focused, into: &context) }
        let focusPath = focused.map(ancestors) ?? []
        // The page the caret is in: the nearest web area above it (Notion nests its web page in a
        // local app shell page, which the walk reaches first).
        context.host = focusPath.first { string($0, kAXRoleAttribute) == "AXWebArea" }.flatMap(host)
        if let window = CaretLocator.attribute(app, kAXFocusedWindowAttribute).map({ $0 as! AXUIElement }) {
            context.windowTitle = string(window, kAXTitleAttribute)
            // Without tmux, a terminal's caret window is the end of its scrollback, not what's on
            // screen: keep its visible lines as a plain field instead of placing the caret.
            walk(window, frame: CaretLocator.frame(of: window), focused: isTerminal && !paneRead ? nil : focused,
                 focusPath: focusPath, started: started, into: &context)
        }
        context.seconds = Date().timeIntervalSince(started)
        return context
    }

    // MARK: Caret

    /// Web-based editors (Chromium, WebKit, Gecko) report the caret as a text-marker range and
    /// often give rich-text fields no plain value, so markers are asked first; plain fields
    /// answer with their value and selected range.
    private static func readCaret(of element: AXUIElement, into context: inout ScreenContext) {
        let window = markerCaretWindow(of: element) ?? valueCaretWindow(of: element)
        guard let window else { return }
        (context.textBeforeCaret, context.selectedText, context.textAfterCaret) = window
    }

    private static func markerCaretWindow(of element: AXUIElement) -> (String, String, String)? {
        func marker(_ name: String, _ range: CFTypeRef) -> CFTypeRef? { CaretLocator.parameterized(element, name, range) }
        func text(_ range: CFTypeRef) -> String? { CaretLocator.parameterized(element, "AXStringForTextMarkerRange", range) as? String }
        func text(from start: CFTypeRef, to end: CFTypeRef) -> String? {
            CaretLocator.parameterized(element, "AXTextMarkerRangeForUnorderedTextMarkers", [start, end] as CFArray).flatMap(text)
        }
        guard let selection = CaretLocator.attribute(element, "AXSelectedTextMarkerRange"),
              let whole = CaretLocator.parameterized(element, "AXTextMarkerRangeForUIElement", element),
              let start = marker("AXStartTextMarkerForTextMarkerRange", whole),
              let end = marker("AXEndTextMarkerForTextMarkerRange", whole),
              let selectionStart = marker("AXStartTextMarkerForTextMarkerRange", selection),
              let selectionEnd = marker("AXEndTextMarkerForTextMarkerRange", selection),
              let before = text(from: start, to: selectionStart),
              let selected = text(selection),
              let after = text(from: selectionEnd, to: end) else { return nil }
        let limit = DictationConfig.contextCaretWindowChars
        return (String(before.suffix(limit)), selected, String(after.prefix(limit)))
    }

    private static func valueCaretWindow(of element: AXUIElement) -> (String, String, String)? {
        guard let value = string(element, kAXValueAttribute),
              let rangeValue = CaretLocator.attribute(element, kAXSelectedTextRangeAttribute),
              CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) else { return nil }
        return ScreenContext.caretWindow(
            in: value, selection: NSRange(location: range.location, length: range.length),
            maxChars: DictationConfig.contextCaretWindowChars
        )
    }

    // MARK: Visible text

    /// Depth-first in child order (reading order), skipping chrome and anything outside the window.
    /// The focused element becomes the caret block at its place in that order.
    /// The focused element's ancestors (`focusPath`) are always walked into, never collapsed (a
    /// Notion row), skipped or pruned, so the caret block lands at its place.
    private static func walk(_ window: AXUIElement, frame windowFrame: CGRect?, focused: AXUIElement?,
                             focusPath: [AXUIElement], started: Date, into context: inout ScreenContext) {
        var stack = [window]
        while let element = stack.popLast() {
            if context.nodesVisited >= DictationConfig.contextNodeBudget { context.stoppedEarly = "node budget"; return }
            if Date().timeIntervalSince(started) > DictationConfig.contextTimeBudget { context.stoppedEarly = "time budget"; return }
            context.nodesVisited += 1

            if let focused, CFEqual(element, focused) {
                context.appendCaret()
                continue
            }
            if focusPath.contains(where: { CFEqual($0, element) }) {
                let children = CaretLocator.attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
                stack.append(contentsOf: children.reversed())
                continue
            }
            if let windowFrame, let frame = CaretLocator.frame(of: element),
               frame.width > 0, frame.height > 0, !frame.intersects(windowFrame) { continue }
            let role = string(element, kAXRoleAttribute) ?? ""
            if DictationConfig.contextSkippedRoles.contains(role) { continue }

            switch role {
            case "AXWebArea":
                if context.host == nil { context.host = host(of: element) }
            case "AXStaticText":
                context.append(.text, string(element, kAXValueAttribute) ?? label(of: element) ?? "")
                continue
            case "AXHeading", "AXLink", "AXRow":
                let kind: ScreenContext.Block.Kind = role == "AXHeading" ? .heading : role == "AXLink" ? .link : .row
                let text = label(of: element) ?? subtreeText(of: element, separator: kind == .row ? " | " : " ", context: &context)
                context.append(kind, text)
                continue
            case "AXTextArea", "AXTextField":
                if let text = visibleText(of: element, windowFrame: windowFrame) { context.append(.field, text) }
                continue
            default:
                break
            }
            let children = CaretLocator.attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            stack.append(contentsOf: children.reversed())
        }
    }

    /// The element's parents up to (not including) the application.
    private static func ancestors(of element: AXUIElement) -> [AXUIElement] {
        var chain: [AXUIElement] = []
        var current = CaretLocator.attribute(element, kAXParentAttribute).map { $0 as! AXUIElement }
        while let parent = current, chain.count < DictationConfig.contextMaxFocusDepth,
              string(parent, kAXRoleAttribute) != kAXApplicationRole as String {
            chain.append(parent)
            current = CaretLocator.attribute(parent, kAXParentAttribute).map { $0 as! AXUIElement }
        }
        return chain
    }

    /// Text of a heading, link or row gathered from its descendants.
    private static func subtreeText(of root: AXUIElement, separator: String, context: inout ScreenContext) -> String {
        var parts: [String] = []
        var length = 0
        var stack = CaretLocator.attribute(root, kAXChildrenAttribute) as? [AXUIElement] ?? []
        stack.reverse()
        while let element = stack.popLast(), length < DictationConfig.contextMaxBlockChars,
              context.nodesVisited < DictationConfig.contextNodeBudget {
            context.nodesVisited += 1
            let role = string(element, kAXRoleAttribute) ?? ""
            if DictationConfig.contextSkippedRoles.contains(role) { continue }
            if role == "AXStaticText" || role == "AXTextField",
               let text = (string(element, kAXValueAttribute) ?? label(of: element))?
                   .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, text != parts.last {
                parts.append(text)
                length += text.count
                continue
            }
            let children = CaretLocator.attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            stack.append(contentsOf: children.reversed())
        }
        return String(parts.joined(separator: separator).prefix(DictationConfig.contextMaxBlockChars))
    }

    /// A field's text, or for a long one (a terminal's scrollback) only the lines inside the window;
    /// nil when a long field can't report its lines.
    private static func visibleText(of element: AXUIElement, windowFrame: CGRect?) -> String? {
        guard let value = string(element, kAXValueAttribute), !value.isEmpty else { return nil }
        let string = value as NSString
        guard string.length > DictationConfig.contextMaxFieldChars, let windowFrame else {
            return value
        }
        guard let lastLine = int(CaretLocator.parameterized(element, kAXLineForIndexParameterizedAttribute as String, (string.length - 1) as CFNumber)) else {
            return nil
        }
        func lineRange(_ line: Int) -> CFRange? {
            guard let value = CaretLocator.parameterized(element, kAXRangeForLineParameterizedAttribute as String, line as CFNumber),
                  CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
            var range = CFRange()
            return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
        }
        func lineTop(_ line: Int) -> CGFloat? {
            guard let range = lineRange(line), range.length > 0 else { return nil }
            return CaretLocator.bounds(of: range, in: element)?.minY
        }
        guard let first = ScreenContext.firstVisibleLine(lineCount: lastLine + 1, windowTop: windowFrame.minY, lineTop: lineTop),
              let start = lineRange(first)?.location else {
            return nil
        }
        let length = min(string.length - start, DictationConfig.contextMaxFieldChars)
        return string.substring(with: string.rangeOfComposedCharacterSequences(for: NSRange(location: start, length: length)))
    }

    // MARK: Terminal

    /// The most recently active tmux client's pane: its foreground program ("claude") and its
    /// visible text split at the cursor. False when tmux isn't running or has no client.
    private static func readTmuxPane(into context: inout ScreenContext) -> Bool {
        guard let tmux = DictationConfig.tmuxPaths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }),
              let clients = run(tmux, ["list-clients", "-F", ScreenContext.TmuxPane.clientFormat]),
              let pane = ScreenContext.activePane(fromTmuxClients: clients),
              let screen = run(tmux, ["capture-pane", "-p", "-t", pane.id]) else { return false }
        if let processes = run("/bin/ps", ["-o", "pid=,tpgid=,comm=", "-t", (pane.tty as NSString).lastPathComponent]) {
            context.terminalProgram = ScreenContext.foregroundProgram(fromPS: processes)
        }
        (context.textBeforeCaret, context.textAfterCaret) = ScreenContext.splitAtCursor(screen, line: pane.cursorY, column: pane.cursorX)
        return true
    }

    private static func run(_ path: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
    }

    // MARK: Attributes

    /// The page's host, or for a non-web page (an extension, an app's own page) its scheme.
    private static func host(of webArea: AXUIElement) -> String? {
        guard let value = CaretLocator.attribute(webArea, kAXURLAttribute) else { return nil }
        let url = CFGetTypeID(value) == CFURLGetTypeID() ? value as? URL : (value as? String).flatMap(URL.init(string:))
        guard let url else { return nil }
        // Only web pages have a meaningful host; an extension or app page has a random ID there.
        return ["http", "https"].contains(url.scheme) ? url.host : url.scheme
    }

    private static func label(of element: AXUIElement) -> String? {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute] {
            if let text = string(element, name), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        }
        return nil
    }

    private static func string(_ element: AXUIElement, _ name: String) -> String? {
        CaretLocator.attribute(element, name) as? String
    }

    private static func int(_ value: CFTypeRef?) -> Int? {
        (value as? NSNumber)?.intValue
    }
}
