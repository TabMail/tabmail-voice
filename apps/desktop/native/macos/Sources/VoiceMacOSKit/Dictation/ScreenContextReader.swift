// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Foundation
import VoiceHelperSupport

/// Reads a `ScreenContext` from an app through Accessibility. Blocking: call off the main thread.
enum ScreenContextReader {
    /// The screen context of the app, or nil when a website the user excludes is showing: nothing of
    /// the window is kept then.
    static func read(pid: pid_t, appName: String, bundleID: String?, excluding exclusions: ScreenExclusions) -> ScreenContext? {
        let started = Date()
        var start = ScreenContext(appName: appName, bundleID: bundleID)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, HelperConfig.contextLookupTimeout)

        let focused = CaretLocator.attribute(app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
        start.focusedRole = focused.flatMap { string($0, kAXRoleAttribute) }
        let focusPath = focused.map(ancestors) ?? []
        let window = CaretLocator.attribute(app, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
        // In a tmux terminal the active pane is read from tmux: the terminal's own text is every
        // pane side by side, and its caret index drifts (iTerm2 drops trailing spaces).
        let isTerminal = bundleID.map(HelperConfig.terminalBundleIDs.contains) ?? false
        guard var context = gather(window: window, focused: focused, focusPath: focusPath, in: LiveScreenTree(), excluding: exclusions,
                                   started: started, from: start,
                                   terminalPane: isTerminal ? { readTmuxPane(showingIn: focused, into: &$0) } : nil) else {
            HelperLog.debug("ScreenContext: the window shows a website excluded from screen reading; not read")
            return nil
        }
        context.seconds = Date().timeIntervalSince(started)
        return context
    }

    /// `start` with the text around the caret and the window's visible text read into it. Nil when
    /// the window shows a page of an excluded website: the page in focus is checked before anything
    /// is read (the caret's text, the window's title), and any other page as the walk reaches it;
    /// nothing gathered is given back then.
    /// `terminalPane` reads a terminal's caret from tmux, and says whether it did.
    static func gather<Tree: ScreenTree>(window: Tree.Element?, focused: Tree.Element?, focusPath: [Tree.Element], in tree: Tree,
                                         excluding exclusions: ScreenExclusions, started: Date, from start: ScreenContext,
                                         terminalPane: ((inout ScreenContext) -> Bool)? = nil) -> ScreenContext? {
        let hosts = focused.map { pageHosts(of: $0, above: focusPath, in: tree) } ?? []
        if hosts.contains(where: exclusions.excludesHost) { return nil }
        var context = start
        let paneRead = terminalPane?(&context) ?? false
        if let focused, !paneRead { readCaret(of: focused, in: tree, into: &context) }
        // The page the caret is in: the nearest web area (Notion nests its web page in a local app
        // shell page, which the walk reaches first).
        context.host = hosts.first ?? nil
        guard let window else { return context }
        context.windowTitle = tree.string(window, kAXTitleAttribute)
        // Without tmux, a terminal's caret window is the end of its scrollback, not what's on
        // screen: keep its visible lines as a plain field instead of placing the caret.
        let read = walk(window, in: tree, frame: tree.frame(of: window), focused: terminalPane != nil && !paneRead ? nil : focused,
                        focusPath: focusPath, excluding: exclusions, started: started, into: &context)
        return read ? context : nil
    }

    /// The hosts of the pages the focused element is in, nearest first: the element itself when it
    /// is a page (a page clicked on has the focus itself), and the web areas above it.
    static func pageHosts<Tree: ScreenTree>(of focused: Tree.Element, above focusPath: [Tree.Element], in tree: Tree) -> [String?] {
        ([focused] + focusPath).filter { tree.string($0, kAXRoleAttribute) == "AXWebArea" }.map(tree.host)
    }

    // MARK: Caret

    /// The text around the caret in the focused field, never a password field's.
    static func readCaret<Tree: ScreenTree>(of element: Tree.Element, in tree: Tree, into context: inout ScreenContext) {
        if isPasswordField(element, in: tree) {
            HelperLog.debug("ScreenContext: the focused field is a password field; not read")
            return
        }
        guard let window = tree.caretWindow(of: element) else { return }
        (context.textBeforeCaret, context.selectedText, context.textAfterCaret) = window
    }

    /// Web-based editors (Chromium, WebKit, Gecko) report the caret as a text-marker range and
    /// often give rich-text fields no plain value, so markers are asked first; plain fields
    /// answer with their value and selected range.
    fileprivate static func caretWindow(of element: AXUIElement) -> (String, String, String)? {
        markerCaretWindow(of: element) ?? valueCaretWindow(of: element)
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
        let limit = HelperConfig.contextCaretWindowChars
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
            maxChars: HelperConfig.contextCaretWindowChars
        )
    }

    // MARK: Visible text

    /// Depth-first in child order (reading order), skipping chrome and anything outside the window.
    /// Each piece of text keeps its frame, so it can be laid out in lines as on screen. In web
    /// content controls and toolbars are read (`contextWebReadRoles`): a control adds the text
    /// drawn in it (`drawnTitle`), else its children's. Text in a hidden box (`isShown`) is left
    /// out, but its box is still walked into: Slack keeps its message list in one.
    /// The focused element becomes the caret block at its place in that order.
    /// The focused element's ancestors (`focusPath`) are always walked into, never collapsed (a
    /// Notion row), skipped or pruned, so the caret block lands at its place.
    /// A password field is never read, nor anything inside it (one above the focused element is
    /// walked into like any of its ancestors; no app is known to focus inside one).
    /// False when the window shows a page of an excluded website, in focus or not: the walk stops
    /// there, and what it gathered must not be used.
    static func walk<Tree: ScreenTree>(_ window: Tree.Element, in tree: Tree, frame windowFrame: CGRect?, focused: Tree.Element?,
                                       focusPath: [Tree.Element], excluding exclusions: ScreenExclusions, started: Date,
                                       into context: inout ScreenContext) -> Bool {
        // Each element with whether it is inside a web area.
        var stack = [(window, false)]
        while let (element, inWeb) = stack.popLast() {
            if context.nodesVisited >= HelperConfig.contextNodeBudget { context.stoppedEarly = "node budget"; return true }
            if Date().timeIntervalSince(started) > HelperConfig.contextTimeBudget { context.stoppedEarly = "time budget"; return true }
            context.nodesVisited += 1

            if let focused, tree.isSame(element, focused) {
                if tree.string(element, kAXRoleAttribute) == "AXWebArea", exclusions.excludesHost(tree.host(of: element)) { return false }
                context.appendCaret(frame: tree.frame(of: element))
                continue
            }
            if focusPath.contains(where: { tree.isSame($0, element) }) {
                let isWebArea = tree.string(element, kAXRoleAttribute) == "AXWebArea"
                if isWebArea, exclusions.excludesHost(tree.host(of: element)) { return false }
                let childrenInWeb = inWeb || isWebArea
                stack.append(contentsOf: tree.children(of: element).reversed().map { ($0, childrenInWeb) })
                continue
            }
            if isPasswordField(element, in: tree) { continue }
            let frame = tree.frame(of: element)
            if let windowFrame, let frame, frame.width > 0, frame.height > 0, !frame.intersects(windowFrame) { continue }
            let role = tree.string(element, kAXRoleAttribute) ?? ""
            if isSkipped(role, inWeb: inWeb) { continue }
            let shown = frame.map(ScreenContext.isShown) ?? true

            switch role {
            case "AXWebArea":
                let host = tree.host(of: element)
                if exclusions.excludesHost(host) { return false }
                if context.host == nil { context.host = host }
            case "AXStaticText":
                if shown { context.append(.text, tree.string(element, kAXValueAttribute) ?? label(of: element, in: tree) ?? "", frame: frame) }
                continue
            case "AXHeading", "AXLink", "AXRow":
                if shown {
                    let kind: ScreenContext.Block.Kind = role == "AXHeading" ? .heading : role == "AXLink" ? .link : .row
                    var text = label(of: element, in: tree)
                    if text == nil {
                        text = subtreeText(of: element, in: tree, separator: kind == .row ? " | " : " ", inWeb: inWeb,
                                           excluding: exclusions, context: &context)
                        // A page of an excluded website is framed in it.
                        if text == nil { return false }
                    }
                    context.append(kind, text ?? "", frame: frame)
                }
                continue
            case "AXTextArea", "AXTextField":
                if shown, let text = tree.fieldText(of: element, windowFrame: windowFrame) { context.append(.field, text, frame: frame) }
                continue
            case _ where inWeb && HelperConfig.contextWebControlRoles.contains(role):
                if let title = drawnTitle(of: element, in: tree) {
                    if shown { context.append(.text, title, frame: frame) }
                    continue
                }
            default:
                break
            }
            stack.append(contentsOf: tree.children(of: element).reversed().map { ($0, inWeb || role == "AXWebArea") })
        }
        return true
    }

    static func isSkipped(_ role: String, inWeb: Bool) -> Bool {
        HelperConfig.contextSkippedRoles.contains(role) && !(inWeb && HelperConfig.contextWebReadRoles.contains(role))
    }

    /// Whether the element is a password field, which is never read: the screen read doesn't rely on
    /// the app hiding the field's value.
    static func isPasswordField<Tree: ScreenTree>(_ element: Tree.Element, in tree: Tree) -> Bool {
        tree.string(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole
    }

    /// The element's parents up to (not including) the application.
    static func ancestors(of element: AXUIElement) -> [AXUIElement] {
        var chain: [AXUIElement] = []
        var current = CaretLocator.attribute(element, kAXParentAttribute).map { $0 as! AXUIElement }
        while let parent = current, chain.count < HelperConfig.contextMaxFocusDepth,
              string(parent, kAXRoleAttribute) != kAXApplicationRole as String {
            chain.append(parent)
            current = CaretLocator.attribute(parent, kAXParentAttribute).map { $0 as! AXUIElement }
        }
        return chain
    }

    /// Text of a heading, link or row gathered from its descendants, as `walk` reads it. Nil when a
    /// page of an excluded website is among them.
    private static func subtreeText<Tree: ScreenTree>(of root: Tree.Element, in tree: Tree, separator: String, inWeb: Bool,
                                                      excluding exclusions: ScreenExclusions, context: inout ScreenContext) -> String? {
        var parts: [String] = []
        var length = 0
        var stack = Array(tree.children(of: root).reversed())
        while let element = stack.popLast(), length < HelperConfig.contextMaxBlockChars,
              context.nodesVisited < HelperConfig.contextNodeBudget {
            context.nodesVisited += 1
            let role = tree.string(element, kAXRoleAttribute) ?? ""
            if role == "AXWebArea", exclusions.excludesHost(tree.host(of: element)) { return nil }
            if isSkipped(role, inWeb: inWeb) || isPasswordField(element, in: tree) { continue }
            let title = inWeb && HelperConfig.contextWebControlRoles.contains(role) ? drawnTitle(of: element, in: tree) : nil
            if role == "AXStaticText" || role == "AXTextField" || title != nil {
                let shown = tree.frame(of: element).map(ScreenContext.isShown) ?? true
                let text = (title ?? tree.string(element, kAXValueAttribute) ?? label(of: element, in: tree))?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if shown, !text.isEmpty, text != parts.last {
                    parts.append(text)
                    length += text.count
                }
                continue
            }
            stack.append(contentsOf: tree.children(of: element).reversed())
        }
        return String(parts.joined(separator: separator).prefix(HelperConfig.contextMaxBlockChars))
    }

    /// A field's text, or for a long one (a terminal's scrollback) only the lines inside the window;
    /// nil when a long field can't report its lines.
    fileprivate static func visibleText(of element: AXUIElement, windowFrame: CGRect?) -> String? {
        guard let value = string(element, kAXValueAttribute), !value.isEmpty else { return nil }
        let string = value as NSString
        guard string.length > HelperConfig.contextMaxFieldChars, let windowFrame else {
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
        let length = min(string.length - start, HelperConfig.contextMaxFieldChars)
        return string.substring(with: string.rangeOfComposedCharacterSequences(for: NSRange(location: start, length: length)))
    }

    // MARK: Terminal

    /// The most recently active tmux client's pane: its foreground program ("claude") and its
    /// visible text split at the cursor. False when tmux isn't running, has no client, or its pane
    /// isn't what the focused terminal shows (tmux attached in another tab or window).
    private static func readTmuxPane(showingIn terminal: AXUIElement?, into context: inout ScreenContext) -> Bool {
        guard let terminal, let terminalText = string(terminal, kAXValueAttribute),
              let tmux = HelperConfig.tmuxPaths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }),
              let clients = run(tmux, ["list-clients", "-F", ScreenContext.TmuxPane.clientFormat]),
              let pane = ScreenContext.activePane(fromTmuxClients: clients),
              let screen = run(tmux, ["capture-pane", "-p", "-t", pane.id]) else { return false }
        guard ScreenContext.paneIsOnScreen(
            pane: screen, screen: String(terminalText.suffix(HelperConfig.tmuxScreenTailChars)),
            sampleLines: HelperConfig.tmuxPaneSampleLines, requiredShare: HelperConfig.tmuxPaneRequiredShare
        ) else {
            HelperLog.debug("ScreenContext: tmux pane \(pane.id) is not the terminal in front")
            return false
        }
        if let processes = run("/bin/ps", ["-o", "pid=,tpgid=,comm=", "-t", (pane.tty as NSString).lastPathComponent]) {
            context.terminalProgram = ScreenContext.foregroundProgram(fromPS: processes)
        }
        (context.textBeforeCaret, context.textAfterCaret) = ScreenContext.splitAtCursor(screen, line: pane.cursorY, column: pane.cursorX)
        return true
    }

    /// A command's output, or nil when it fails or hasn't finished within `timeout` seconds (then
    /// it is stopped). Waiting for the end of the output isn't enough: a tmux client hands its
    /// output to the tmux server, so while that server is stopped the output never ends, even once
    /// the client is killed.
    static func run(_ path: String, _ arguments: [String], timeout: Double = HelperConfig.contextCommandTimeout) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do { try process.run() } catch { return nil }

        let deadline = Date().addingTimeInterval(timeout)
        let reader = output.fileHandleForReading
        var data = Data()
        while true {
            let remaining = Int32(deadline.timeIntervalSinceNow * 1000)
            var request = pollfd(fd: reader.fileDescriptor, events: Int16(POLLIN), revents: 0)
            guard remaining > 0, poll(&request, 1, remaining) > 0 else { return stop(process, path) }
            let chunk = reader.availableData
            if chunk.isEmpty { break }
            data.append(chunk)
        }
        guard exited.wait(timeout: .now() + max(0, deadline.timeIntervalSinceNow)) == .success else { return stop(process, path) }
        return process.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
    }

    private static func stop(_ process: Process, _ path: String) -> String? {
        process.terminate()
        HelperLog.debug("ScreenContext: \((path as NSString).lastPathComponent) didn't finish in time; stopped")
        return nil
    }

    // MARK: Attributes

    /// The page's host, or for a non-web page (an extension, an app's own page) its scheme.
    fileprivate static func host(of webArea: AXUIElement) -> String? {
        guard let value = CaretLocator.attribute(webArea, kAXURLAttribute) else { return nil }
        let url = CFGetTypeID(value) == CFURLGetTypeID() ? value as? URL : (value as? String).flatMap(URL.init(string:))
        guard let url else { return nil }
        // Only web pages have a meaningful host; an extension or app page has a random ID there.
        return ["http", "https"].contains(url.scheme) ? url.host : url.scheme
    }

    private static func label<Tree: ScreenTree>(of element: Tree.Element, in tree: Tree) -> String? {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute] {
            if let text = tree.string(element, name), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        }
        return nil
    }

    /// A web control's title when it is the text drawn in the control. Chromium and WebKit title a
    /// control with its contents (Slack's message author, "10 replies"); a label for screen readers
    /// (an icon button's "Copy") comes as its description, and was seen as the title as well in an
    /// Electron app.
    private static func drawnTitle<Tree: ScreenTree>(of element: Tree.Element, in tree: Tree) -> String? {
        drawnTitle(title: tree.string(element, kAXTitleAttribute), description: tree.string(element, kAXDescriptionAttribute))
    }

    static func drawnTitle(title: String?, description: String?) -> String? {
        func text(_ value: String?) -> String? { value.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 } }
        return text(description) == nil ? text(title) : nil
    }

    private static func string(_ element: AXUIElement, _ name: String) -> String? {
        CaretLocator.attribute(element, name) as? String
    }

    private static func int(_ value: CFTypeRef?) -> Int? {
        (value as? NSNumber)?.intValue
    }
}

/// What the walk reads from an app's elements: Accessibility (`LiveScreenTree`), or a fake tree in tests.
protocol ScreenTree {
    associatedtype Element
    func children(of element: Element) -> [Element]
    func frame(of element: Element) -> CGRect?
    func string(_ element: Element, _ name: String) -> String?
    /// The host of a web area's page.
    func host(of webArea: Element) -> String?
    /// A text field's visible text.
    func fieldText(of element: Element, windowFrame: CGRect?) -> String?
    /// The focused field's text before the caret, selected, and after it.
    func caretWindow(of element: Element) -> (String, String, String)?
    func isSame(_ first: Element, _ second: Element) -> Bool
}

struct LiveScreenTree: ScreenTree {
    func children(of element: AXUIElement) -> [AXUIElement] {
        CaretLocator.attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }

    func frame(of element: AXUIElement) -> CGRect? { CaretLocator.frame(of: element) }

    func string(_ element: AXUIElement, _ name: String) -> String? { CaretLocator.attribute(element, name) as? String }

    func host(of webArea: AXUIElement) -> String? { ScreenContextReader.host(of: webArea) }

    func fieldText(of element: AXUIElement, windowFrame: CGRect?) -> String? {
        ScreenContextReader.visibleText(of: element, windowFrame: windowFrame)
    }

    func caretWindow(of element: AXUIElement) -> (String, String, String)? { ScreenContextReader.caretWindow(of: element) }

    func isSame(_ first: AXUIElement, _ second: AXUIElement) -> Bool { CFEqual(first, second) }
}
