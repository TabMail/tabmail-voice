// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Foundation
import Darwin
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
        return read(window: window, focused: focused, focusPath: focusPath, in: LiveScreenTree(),
            current: { name in
                guard let value = CaretLocator.attribute(app, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
                return (value as! AXUIElement)
            }, excluding: exclusions, started: started, from: start)
    }

    /// Dispatch after native focus acquisition, shared by live AX and collector fixtures.
    static func read<Tree: TerminalTree>(window: Tree.Element?, focused: Tree.Element?, focusPath: [Tree.Element],
                                        in tree: Tree, current: (String) -> Tree.Element?,
                                        excluding exclusions: ScreenExclusions, started: Date,
                                        from start: ScreenContext) -> ScreenContext? {
        if start.bundleID.map(HelperConfig.terminalBundleIDs.contains) ?? false {
            return TerminalViewportReader.read(window: window, focused: focused, focusPath: focusPath,
                in: tree, current: current, excluding: exclusions, started: started, from: start)
        }
        guard var context = gather(window: window, focused: focused, focusPath: focusPath, in: tree, excluding: exclusions,
                                   started: started, from: start) else {
            HelperLog.debug("ScreenContext: the window shows a page of an excluded website, or one whose address is unknown; not read")
            return nil
        }
        context.seconds = Date().timeIntervalSince(started)
        return context
    }

    /// `start` with the text around the caret and the window's visible text read into it. Nil when
    /// the window shows a page of an excluded website: the page in focus is checked before anything
    /// is read (the caret's text, the window's title), and any other page as the walk reaches it;
    /// nothing gathered is given back then.
    static func gather<Tree: ScreenTree>(window: Tree.Element?, focused: Tree.Element?, focusPath: [Tree.Element], in tree: Tree,
                                         excluding exclusions: ScreenExclusions, started: Date, from start: ScreenContext) -> ScreenContext? {
        let hosts = focused.map { pageHosts(of: $0, above: focusPath, in: tree) } ?? []
        if hosts.contains(where: exclusions.excludes) { return nil }
        if let focused, holdsExcludedPage(focused, in: tree, excluding: exclusions, within: HelperConfig.contextTimeBudget, since: started) {
            return nil
        }
        var context = start
        if let focused {
            readCaret(of: focused, in: tree, into: &context)
            // A focused element that is no field (a page clicked on, a list, a row) is read by the
            // walk like any element: the text around its caret is its own, which the walk reads as
            // it is laid out (Safari and Chrome give none there at all). Only what is selected in
            // it is kept.
            if !isFieldInFocus(focused, in: tree) {
                context.textBeforeCaret = ""
                context.textAfterCaret = ""
            }
        }
        // The page the caret is in: the nearest web area (Notion nests its web page in a local app
        // shell page, which the walk reaches first).
        context.host = hosts.first?.name
        guard let window else { return context }
        context.windowTitle = tree.sourceString(window, kAXTitleAttribute)
        let read = walk(window, in: tree, frame: tree.frame(of: window), focused: focused,
                        focusPath: focusPath, excluding: exclusions, started: started, into: &context)
        return read ? context : nil
    }

    /// Whether the focused element is the field the caret is in: a text field or text area, or an
    /// element whose text can be changed (a web area that is a mail's compose window or a
    /// rich-text editor's document). Anything else in focus (a page clicked on, a list, a row, a
    /// button) is read, not written in, and the walk reads it like any element.
    static func isFieldInFocus<Tree: ScreenTree>(_ focused: Tree.Element, in tree: Tree) -> Bool {
        HelperConfig.contextFieldRoles.contains(tree.string(focused, kAXRoleAttribute) ?? "") || tree.isEditable(focused)
    }

    /// The hosts of the pages the focused element is in, nearest first: the element itself when it
    /// is a page (a page clicked on has the focus itself), and the web areas above it.
    static func pageHosts<Tree: ScreenTree>(of focused: Tree.Element, above focusPath: [Tree.Element], in tree: Tree) -> [PageHost] {
        ([focused] + focusPath).filter { tree.string($0, kAXRoleAttribute) == "AXWebArea" }.map(tree.page)
    }

    /// Whether a page of an excluded website is inside `element`: a page that frames it has the
    /// focus itself, or a focused group holds it. The walk never goes into a focused field, and
    /// goes into any other focused element only after the text around its caret was asked for, so
    /// it is looked into here first, for pages only: no text is asked for.
    /// `intoPages` false stops at each page that is not excluded, without looking for one framed
    /// in it. Bounded by the walk's node budget and by `seconds` since `started`; past them the
    /// element is taken to hold none, or, with `unlessSeenWhole`, to hold one: a field is read only
    /// when all of it was looked through.
    static func holdsExcludedPage<Tree: ScreenTree>(_ element: Tree.Element, in tree: Tree, excluding exclusions: ScreenExclusions,
                                                    intoPages: Bool = true, unlessSeenWhole: Bool = false,
                                                    within seconds: Double, since started: Date) -> Bool {
        switch lookForExcludedPage(in: element, tree, excluding: exclusions, intoPages: intoPages, within: seconds, since: started) {
        case .excluded: return true
        case .none: return false
        case .notSeenWhole: return unlessSeenWhole
        }
    }

    /// What a look inside an element for a page of an excluded website found.
    enum PageLook { case none, excluded, notSeenWhole }

    /// The look behind `holdsExcludedPage`, which also says when it gave up at a budget before
    /// the element was seen whole.
    static func lookForExcludedPage<Tree: ScreenTree>(in element: Tree.Element, _ tree: Tree, excluding exclusions: ScreenExclusions,
                                                      intoPages: Bool = true, within seconds: Double, since started: Date) -> PageLook {
        var stack = tree.children(of: element)
        var visited = 0
        while let next = stack.popLast() {
            if visited >= HelperConfig.contextNodeBudget || Date().timeIntervalSince(started) > seconds { return .notSeenWhole }
            visited += 1
            if tree.string(next, kAXRoleAttribute) == "AXWebArea" {
                if exclusions.excludes(tree.page(of: next)) { return .excluded }
                if !intoPages { continue }
            }
            stack.append(contentsOf: tree.children(of: next))
        }
        return .none
    }

    // MARK: Caret

    /// The text around the caret in the focused field, never a password field's.
    static func readCaret<Tree: ScreenTree>(of element: Tree.Element, in tree: Tree, into context: inout ScreenContext) {
        if isPasswordField(element, in: tree) {
            HelperLog.debug("ScreenContext: the focused field is a password field; not read")
            return
        }
        guard let window = tree.caretWindow(of: element) else { return }
        guard window.parts.count == 3 else { context.coreFailed = true; return }
        context.textBeforeCaret = window.parts[0]
        context.selectedText = window.parts[1]
        context.textAfterCaret = window.parts[2]
        context.selectionUnavailable = window.selectionUnavailable
    }

    /// Web-based editors (Chromium, WebKit, Gecko) report the caret as a text-marker range and
    /// often give rich-text fields no plain value, so markers are asked first; plain fields
    /// answer with their character count and parameterized string ranges.
    fileprivate static func caretWindow(of element: AXUIElement) -> SharedContext.CaretWindow? {
        markerCaretWindow(of: element) ?? valueCaretWindow(of: element)
    }

    private static func markerCaretWindow(of element: AXUIElement) -> SharedContext.CaretWindow? {
        let started = Date()
        func withinBudget() -> Bool { Date().timeIntervalSince(started) <= HelperConfig.contextTimeBudget }
        return MarkerCaretSource.read(snapshot: {
            guard withinBudget(),
                  let selection = CaretLocator.attribute(element, "AXSelectedTextMarkerRange"),
                  let whole = CaretLocator.parameterized(element, "AXTextMarkerRangeForUIElement", element),
                  withinBudget() else { return nil }
            return (selection, whole)
        }, parameterized: { name, value in
            guard withinBudget() else { return nil }
            let result = CaretLocator.parameterized(element, name, value)
            return withinBudget() ? result : nil
        }, focused: {
            withinBudget() && (CaretLocator.attribute(element, kAXFocusedAttribute) as? NSNumber)?.boolValue == true
        })
    }

    private static func valueCaretWindow(of element: AXUIElement) -> SharedContext.CaretWindow? {
        let started = Date()
        func withinBudget() -> Bool { Date().timeIntervalSince(started) <= HelperConfig.contextTimeBudget }
        func text(_ requested: NSRange) -> NSString? {
            var range = CFRange(location: requested.location, length: requested.length)
            guard withinBudget(), let parameter = AXValueCreate(.cfRange, &range),
                  let value = CaretLocator.parameterized(element, kAXStringForRangeParameterizedAttribute as String, parameter) as? NSString,
                  withinBudget() else { return nil }
            return value
        }
        return valueCaretWindow(snapshot: {
            valueSnapshot(markers: {
                guard withinBudget(), let selection = CaretLocator.attribute(element, "AXSelectedTextMarkerRange"),
                      let whole = CaretLocator.parameterized(element, "AXTextMarkerRangeForUIElement", element) else { return nil }
                return (selection, whole)
            }, parameterized: { name, value in
                guard withinBudget() else { return nil }
                let result = CaretLocator.parameterized(element, name, value)
                return withinBudget() ? result : nil
            }, characters: {
                guard let count = int(CaretLocator.attribute(element, kAXNumberOfCharactersAttribute)),
                      let value = CaretLocator.attribute(element, kAXSelectedTextRangeAttribute),
                      CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
                var range = CFRange()
                guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
                return (count, NSRange(location: range.location, length: range.length))
            }, string: text)
        }, string: { requested in
            guard let value = text(requested) else {
                HelperLog.debug("ScreenContext: no text for \(requested.location)+\(requested.length) after \(Int(Date().timeIntervalSince(started) * 1000)) ms")
                return nil
            }
            return value
        }, focused: {
            (CaretLocator.attribute(element, kAXFocusedAttribute) as? NSNumber)?.boolValue == true
        })
    }

    /// A field's length and selection, and whether its markers counted them.
    struct ValueSnapshot: Equatable {
        let count: Int
        let range: NSRange
        let markers: Bool
    }

    /// A field with text markers but no public marker-index conversion (Chromium; WebKit, which
    /// answers it only under private names) is counted and placed by its markers
    /// (`MarkerCaretSource.selection`), any other by its character count and range. Only a field
    /// with a character count is: an element that is no text field (a page, a link) has none, and
    /// its markers would place a selection made before it inside it. The markers are trusted only when the field's string ranges end where they do: Chromium
    /// counts an image or other embedded object as a character in its markers but not in its
    /// string ranges, which would shift every range read. A field whose value has no characters is
    /// empty, whatever its markers say: Chromium gives an empty text field its placeholder in them.
    static func valueSnapshot(markers: () -> (selection: CFTypeRef, whole: CFTypeRef)?, parameterized: (String, CFTypeRef) -> CFTypeRef?,
                              characters: () -> (count: Int, range: NSRange)?, string: (NSRange) -> NSString?) -> ValueSnapshot? {
        let characters = characters()
        if let characters, characters.count != 0, let state = markers(),
           let selection = MarkerCaretSource.selection(selection: state.selection, whole: state.whole, parameterized: parameterized),
           selection.count == 0 || string(NSRange(location: selection.count - 1, length: 1))?.length == 1,
           (string(NSRange(location: selection.count, length: 1))?.length ?? 0) == 0 {
            return ValueSnapshot(count: selection.count, range: selection.range, markers: true)
        }
        return characters.map { ValueSnapshot(count: $0.count, range: $0.range, markers: false) }
    }

    /// The text around a field's selection, read by its string ranges; unavailable when the field
    /// changed or lost the focus while it was read, or a range gave no text of its length.
    static func valueCaretWindow(snapshot: () -> ValueSnapshot?, string: (NSRange) -> NSString?, focused: () -> Bool) -> SharedContext.CaretWindow? {
        guard let initial = snapshot() else { return nil }
        HelperLog.debug("ScreenContext: caret \(initial.range.location)+\(initial.range.length) of \(initial.count) chars, from the \(initial.markers ? "text markers" : "character range")")
        let unavailable = SharedContext.CaretWindow(parts: ["", Redactor.placeholder, ""], selectionUnavailable: true)
        do {
            let result = try BoundedCaretSource.read(count: initial.count, selection: initial.range) { requested in
                let value = string(requested)
                if let value, value.length != requested.length {
                    HelperLog.debug("ScreenContext: \(value.length) characters for \(requested.location)+\(requested.length)")
                }
                return value
            }
            let final = snapshot()
            let isFocused = focused()
            guard let final, final == initial, isFocused else {
                HelperLog.debug("ScreenContext: the field changed while it was read (now \(final.map { "\($0.range.location)+\($0.range.length) of \($0.count)" } ?? "unreadable"), focused \(isFocused)); selection unavailable")
                return unavailable
            }
            return result
        } catch {
            HelperLog.debug("ScreenContext: the field's text could not be read around the caret; selection unavailable")
            return unavailable
        }
    }

    // MARK: Visible text

    /// Depth-first in child order (reading order), skipping chrome and anything outside the window.
    /// Each piece of text keeps its frame, so it can be laid out in lines as on screen. In web
    /// content controls and toolbars are read (`contextWebReadRoles`): a control adds the text
    /// drawn in it (`drawnTitle`), else its children's. Text in a hidden box (`isShown`) is left
    /// out, but its box is still walked into: Slack keeps its message list in one.
    /// The focused field becomes the caret block at its place in that order; a focused element that
    /// is no field (`isFieldInFocus`: a page clicked on, a list, a row) is read like any element,
    /// after its selection, if any, as the caret block.
    /// The focused element's ancestors (`focusPath`) are always walked into, never collapsed (a
    /// Notion row), skipped or pruned, so the caret block lands at its place.
    /// A password field is never read, nor anything inside it (one above the focused element is
    /// walked into like any of its ancestors; no app is known to focus inside one).
    /// False when the window shows a page of an excluded website, in focus or not: the walk stops
    /// there, and what it gathered must not be used. A field that frames such a page (a field is read
    /// by its value, never walked into) is not read, and `contextHiddenMarker` stands in its place.
    /// An element read in one piece by a label of its own and not walked into (a piece of text, a
    /// heading, a link, a row, a web control with its title) is looked through for such a page
    /// (`lookForExcludedPage`): its label can be made of what it holds. One that holds such a page
    /// refuses the window; one too large to look through is not read, and the marker stands in its place.
    static func walk<Tree: ScreenTree>(_ window: Tree.Element, in tree: Tree, frame windowFrame: CGRect?, focused: Tree.Element?,
                                       focusPath: [Tree.Element], excluding exclusions: ScreenExclusions, started: Date,
                                       into context: inout ScreenContext) -> Bool {
        // Each element with whether it is inside a web area.
        context.prepareTextBudget()
        var stack = [(window, false)]
        while let (element, inWeb) = stack.popLast() {
            if context.coreFailed { return true }
            if context.textBudgetFull { context.stoppedEarly = "text budget"; return true }
            if context.nodesVisited >= HelperConfig.contextNodeBudget { context.stoppedEarly = "node budget"; return true }
            if Date().timeIntervalSince(started) > HelperConfig.contextTimeBudget { context.stoppedEarly = "time budget"; return true }
            context.nodesVisited += 1

            let isFocus = focused.map { tree.isSame(element, $0) } ?? false
            if isFocus {
                if tree.string(element, kAXRoleAttribute) == "AXWebArea", exclusions.excludes(tree.page(of: element)) { return false }
                if isFieldInFocus(element, in: tree) {
                    context.appendCaret(frame: tree.frame(of: element))
                    continue
                }
                if !context.selectedText.isEmpty { context.appendCaret(frame: tree.frame(of: element)) }
            } else if focusPath.contains(where: { tree.isSame($0, element) }) {
                let isWebArea = tree.string(element, kAXRoleAttribute) == "AXWebArea"
                if isWebArea, exclusions.excludes(tree.page(of: element)) { return false }
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
            func look() -> PageLook {
                lookForExcludedPage(in: element, tree, excluding: exclusions, within: HelperConfig.contextTimeBudget, since: started)
            }

            switch role {
            case "AXWebArea":
                let page = tree.page(of: element)
                if exclusions.excludes(page) { return false }
                if context.host == nil { context.host = page.name }
            case "AXStaticText":
                if shown {
                    let held = look()
                    if held == .excluded { return false }
                    context.append(.text, held == .notSeenWhole ? HelperConfig.contextHiddenMarker
                        : tree.sourceString(element, kAXValueAttribute) ?? label(of: element, in: tree) ?? "", frame: frame)
                }
                continue
            case "AXHeading", "AXLink", "AXRow":
                if shown {
                    let kind: ScreenContext.Block.Kind = role == "AXHeading" ? .heading : role == "AXLink" ? .link : .row
                    do {
                        let reducer = try SharedSemanticText(kind == .row ? .row : kind == .heading ? .heading : .link)
                        // Rust requests the source. Approval precedes each aggregate label read.
                        func rootLabel() -> String? {
                            let held = look()
                            if held == .excluded { return nil }
                            return held == .notSeenWhole ? HelperConfig.contextHiddenMarker : label(of: element, in: tree) ?? ""
                        }
                        if try reducer.decision == .root {
                            guard let root = rootLabel() else { return false }
                            try reducer.offer(.root, root)
                        }
                        if try reducer.decision == .descendants {
                            guard try subtreeText(of: element, in: tree, reducer: reducer, inWeb: inWeb, windowFrame: windowFrame,
                                                  excluding: exclusions, started: started, context: &context) else { return false }
                        }
                        if try reducer.decision == .root {
                            guard let root = rootLabel() else { return false }
                            try reducer.offer(.root, root)
                        }
                        context.appendSemantic(kind, try reducer.projectedSource(), frame: frame)
                    } catch {
                        context.coreFailed = true; context.stoppedEarly = "shared core refused"
                        return true
                    }
                }
                continue
            case "AXTextArea", "AXTextField":
                // A field is read by its value and not walked into, so a page framed in it is looked for:
                // a field holding one, or too large to look through, is not read, and the read says
                // that something there is hidden.
                if shown {
                    let hidden = holdsExcludedPage(element, in: tree, excluding: exclusions, unlessSeenWhole: true,
                                                   within: HelperConfig.contextTimeBudget, since: started)
                    if hidden {
                        context.append(.field, HelperConfig.contextHiddenMarker, frame: frame)
                    } else if let source = tree.fieldSource(of: element, windowFrame: windowFrame) {
                        context.appendField(source, frame: frame)
                    }
                }
                continue
            case _ where inWeb && HelperConfig.contextWebControlRoles.contains(role):
                if let title = drawnTitle(of: element, in: tree) {
                    if shown {
                        let held = look()
                        if held == .excluded { return false }
                        context.append(.text, held == .notSeenWhole ? HelperConfig.contextHiddenMarker : title, frame: frame)
                    }
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

    /// Text of a heading, link or row gathered from its descendants, as `walk` reads it: its text,
    /// and its fields' and text views' (a native chat app's message is a text area in its table
    /// row). Nil when a page of an excluded website is among them.
    private static func subtreeText<Tree: ScreenTree>(of root: Tree.Element, in tree: Tree, reducer: SharedSemanticText, inWeb: Bool, windowFrame: CGRect?,
                                                      excluding exclusions: ScreenExclusions, started: Date,
                                                      context: inout ScreenContext) throws -> Bool {
        if context.nodesVisited >= HelperConfig.contextNodeBudget || Date().timeIntervalSince(started) > HelperConfig.contextTimeBudget {
            context.stoppedEarly = context.nodesVisited >= HelperConfig.contextNodeBudget ? "node budget" : "time budget"
            try reducer.offer(.interrupted)
            return true
        }
        var stack = Array(tree.children(of: root).reversed())
        while try reducer.decision == .descendants, !stack.isEmpty {
            if context.nodesVisited >= HelperConfig.contextNodeBudget { context.stoppedEarly = "node budget"; break }
            if Date().timeIntervalSince(started) > HelperConfig.contextTimeBudget { context.stoppedEarly = "time budget"; break }
            let element = stack.removeLast()
            context.nodesVisited += 1
            let role = tree.string(element, kAXRoleAttribute) ?? ""
            if role == "AXWebArea", exclusions.excludes(tree.page(of: element)) { return false }
            if isSkipped(role, inWeb: inWeb) || isPasswordField(element, in: tree) { continue }
            let frame = tree.frame(of: element)
            if let windowFrame, let frame, frame.width > 0, frame.height > 0, !frame.intersects(windowFrame) { continue }
            let shown = frame.map(ScreenContext.isShown) ?? true
            if !shown { continue }
            let title = inWeb && HelperConfig.contextWebControlRoles.contains(role) ? drawnTitle(of: element, in: tree) : nil
            if role == "AXStaticText" || role == "AXTextField" || role == "AXTextArea" || title != nil {
                // A field is read by its value and not walked into, so a page framed in it is looked
                // for: a field holding one is not read, and the row says that something there is hidden.
                // A piece of text or a titled control that holds one refuses the window, as in the
                // walk, and one too large to look through is hidden like such a field.
                var hidden = false
                if shown, role == "AXTextField" || role == "AXTextArea" {
                    hidden = holdsExcludedPage(element, in: tree, excluding: exclusions, unlessSeenWhole: true,
                                               within: HelperConfig.contextTimeBudget, since: started)
                } else if shown {
                    switch lookForExcludedPage(in: element, tree, excluding: exclusions, within: HelperConfig.contextTimeBudget, since: started) {
                    case .excluded: return false
                    case .notSeenWhole: hidden = true
                    case .none: break
                    }
                }
                if !hidden && (role == "AXTextField" || role == "AXTextArea") {
                    if let parts = tree.fieldSource(of: element, windowFrame: windowFrame) {
                        try reducer.offerProjected(.descendant, parts)
                    } else if let label = label(of: element, in: tree) {
                        // Value-less native fields can still expose an approved caption.
                        try reducer.offer(.descendant, label)
                    }
                } else {
                    let text = hidden ? HelperConfig.contextHiddenMarker
                        : (title ?? tree.sourceString(element, kAXValueAttribute) ?? label(of: element, in: tree)) ?? ""
                    try reducer.offer(.descendant, text)
                }
                continue
            }
            stack.append(contentsOf: tree.children(of: element).reversed())
        }
        if try reducer.decision == .descendants {
            let complete = stack.isEmpty && context.nodesVisited < HelperConfig.contextNodeBudget && Date().timeIntervalSince(started) <= HelperConfig.contextTimeBudget
            try reducer.offer(complete ? .complete : .interrupted)
        }
        return true
    }

    /// OS capability/visibility adapter; no native text clipping or byte policy.
    fileprivate static func visibleSource(of element: AXUIElement, windowFrame: CGRect?) -> [String]? {
        let started = Date()
        func withinBudget() -> Bool { Date().timeIntervalSince(started) <= HelperConfig.contextTimeBudget }
        func attribute(_ name: String) throws -> CFTypeRef? {
            var value: CFTypeRef?
            switch AXUIElementCopyAttributeValue(element, name as CFString, &value) {
            case .success: return value
            case .attributeUnsupported, .noValue, .notImplemented: return nil
            default: throw Redactor.Failure.refused
            }
        }
        do {
            func characterCount() throws -> Int? {
                guard let value = try attribute(kAXNumberOfCharactersAttribute) else { return nil }
                guard CFGetTypeID(value) != CFBooleanGetTypeID(), let number = value as? NSNumber,
                      number.intValue >= 0, number.doubleValue == Double(number.intValue) else { throw Redactor.Failure.refused }
                return number.intValue
            }
            let count = try characterCount()
            var names: CFArray?
            let status = AXUIElementCopyParameterizedAttributeNames(element, &names)
            guard status == .success || status == .notImplemented else { return nil }
            let ranged = (names as? [String])?.contains(kAXStringForRangeParameterizedAttribute as String) == true
            let reader: ((NSRange) -> NSString?)? = ranged ? { requested in
                var range = CFRange(location: requested.location, length: requested.length)
                guard let parameter = AXValueCreate(.cfRange, &range) else { return nil }
                return CaretLocator.parameterized(element, kAXStringForRangeParameterizedAttribute as String, parameter) as? NSString
            } : nil
            func visible(_ count: Int) -> NSRange? {
                guard withinBudget() else { return nil }
                guard let windowFrame else { return NSRange(location: 0, length: count) }
                guard windowFrame.minY.isFinite, windowFrame.maxY.isFinite else { return nil }
                do {
                    if let value = try attribute(kAXVisibleCharacterRangeAttribute) {
                        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
                        var range = CFRange()
                        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
                        return NSRange(location: range.location, length: range.length)
                    }
                } catch { return nil }
                guard count > 0, let lastLine = int(CaretLocator.parameterized(element, kAXLineForIndexParameterizedAttribute as String, (count - 1) as CFNumber)),
                      lastLine >= 0, lastLine < count else { return nil }
                func lineRange(_ line: Int) -> CFRange? {
                    guard withinBudget(), let value = CaretLocator.parameterized(element, kAXRangeForLineParameterizedAttribute as String, line as CFNumber),
                          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
                    var range = CFRange()
                    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
                }
                var geometryFailed = false
                func lineTop(_ line: Int) -> CGFloat? {
                    guard let range = lineRange(line), range.length > 0,
                          let top = CaretLocator.bounds(of: range, in: element)?.minY, top.isFinite else {
                        geometryFailed = true
                        return nil
                    }
                    return top
                }
                // Retains the reference route for providers with monotonic line
                // geometry (not a guarantee for arbitrary multi-column layouts).
                guard let first = ScreenContext.firstVisibleLine(lineCount: lastLine + 1, windowTop: windowFrame.minY, lineTop: lineTop),
                      let start = lineRange(first)?.location, start >= 0, start <= count else { return nil }
                let below = ScreenContext.firstVisibleLine(lineCount: lastLine + 1, windowTop: windowFrame.maxY, lineTop: lineTop)
                guard !geometryFailed else { return nil }
                let end: Int
                if let below {
                    guard let location = lineRange(below)?.location else { return nil }
                    end = location
                } else { end = count }
                guard end >= start, end <= count else { return nil }
                return NSRange(location: start, length: end - start)
            }
            var visibleSnapshot: (Int, NSRange)?
            let result = try BoundedFieldReader.read(count: count, whole: {
                (try? attribute(kAXValueAttribute)) as? NSString
            }, range: reader, visible: { actualCount in
                guard let interval = visible(actualCount) else { return nil }
                visibleSnapshot = (actualCount, interval)
                return interval
            }, valid: {
                guard withinBudget() else { return false }
                guard let count else { return true }
                return (try? characterCount()) == count
            })
            if let (actualCount, interval) = visibleSnapshot, visible(actualCount) != interval { return nil }
            return result?.parts
        } catch { return nil }
    }

    // MARK: Attributes

    fileprivate static func page(of webArea: AXUIElement) -> PageHost {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(webArea, kAXURLAttribute as CFString, &value)
        return page(result, address: value)
    }

    /// What the app's answer to a page's address says of the page: a page that has no address has
    /// no host, and an answer that failed any other way (the app too slow, or gone) leaves the page
    /// unknown, which is read as excluded.
    static func page(_ result: AXError, address: CFTypeRef?) -> PageHost {
        switch result {
        case .success: address.map(addressHost(ofAddress:)) ?? .noHost
        case .noValue, .attributeUnsupported: .noHost
        default: .unknown
        }
    }

    /// The host of a page's address as the app gives it (a URL, or its text), or for a non-web
    /// page its scheme.
    static func host(ofAddress value: CFTypeRef) -> String? {
        addressHost(ofAddress: value).name
    }

    static func addressHost(ofAddress value: CFTypeRef) -> PageHost {
        let address: String?
        if CFGetTypeID(value) == CFURLGetTypeID() { address = (value as? URL)?.absoluteString }
        else { address = value as? String }
        guard let address else { return .unknown }
        do {
            let data = try Redactor.request(JSONSerialization.data(withJSONObject: ["address": address]), operation: .address)
            guard let result = try JSONSerialization.jsonObject(with: data) as? [String: String] else { return .unknown }
            switch result["kind"] {
            case "noHost": return .noHost
            case "host": return result["host"].map(PageHost.host) ?? .unknown
            default: return .unknown
            }
        } catch { return .unknown }
    }

    private static func label<Tree: ScreenTree>(of element: Tree.Element, in tree: Tree) -> String? {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute] {
            if let text = tree.sourceString(element, name), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        }
        return nil
    }

    /// A web control's title when it is the text drawn in the control. Chromium and WebKit title a
    /// control with its contents (Slack's message author, "10 replies"); a label for screen readers
    /// (an icon button's "Copy") comes as its description, and was seen as the title as well in an
    /// Electron app.
    private static func drawnTitle<Tree: ScreenTree>(of element: Tree.Element, in tree: Tree) -> String? {
        drawnTitle(title: tree.sourceString(element, kAXTitleAttribute), description: tree.string(element, kAXDescriptionAttribute))
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
    func sourceString(_ element: Element, _ name: String) -> String?
    /// What a web area says of its page's address.
    func page(of webArea: Element) -> PageHost
    /// A text field's visible text.
    func fieldSource(of element: Element, windowFrame: CGRect?) -> [String]?
    /// The focused field's text before the caret, selected, and after it.
    func caretWindow(of element: Element) -> SharedContext.CaretWindow?
    func isSame(_ first: Element, _ second: Element) -> Bool
    /// Whether the element's text can be changed: a web area that is itself an editor's document.
    func isEditable(_ element: Element) -> Bool
}

extension ScreenTree {
    func sourceString(_ element: Element, _ name: String) -> String? {
        guard let value = string(element, name) else { return nil }
        return try? BoundedCaretSource.snapshot(value as NSString)
    }
}

struct LiveScreenTree: ScreenTree {
    func children(of element: AXUIElement) -> [AXUIElement] {
        CaretLocator.attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }

    func frame(of element: AXUIElement) -> CGRect? { CaretLocator.frame(of: element) }

    func string(_ element: AXUIElement, _ name: String) -> String? { CaretLocator.attribute(element, name) as? String }

    func sourceString(_ element: AXUIElement, _ name: String) -> String? {
        guard let value = CaretLocator.attribute(element, name) as? NSString else { return nil }
        return try? BoundedCaretSource.snapshot(value)
    }

    func page(of webArea: AXUIElement) -> PageHost { ScreenContextReader.page(of: webArea) }

    func fieldSource(of element: AXUIElement, windowFrame: CGRect?) -> [String]? {
        ScreenContextReader.visibleSource(of: element, windowFrame: windowFrame)
    }

    func caretWindow(of element: AXUIElement) -> SharedContext.CaretWindow? { ScreenContextReader.caretWindow(of: element) }

    /// An element whose value the app lets be set: observed true for an editable web area in WebKit
    /// and Gecko, false for a page that is only read.
    func isEditable(_ element: AXUIElement) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
    }

    func isSame(_ first: AXUIElement, _ second: AXUIElement) -> Bool { CFEqual(first, second) }
}
