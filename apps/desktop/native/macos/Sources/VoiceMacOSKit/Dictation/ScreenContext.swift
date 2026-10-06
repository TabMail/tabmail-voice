// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// What was on screen when a dictation started: the app, where in it, the text around the caret
/// and the visible text in reading order, laid out in lines as on screen. User content: never stored, and logged only to the debug
/// log file (`logDescription`, ADR-DESK-015); `summary` is what the other logs carry.
struct ScreenContext: Sendable, Equatable {
    struct Block: Sendable, Equatable {
        enum Kind: String, Sendable {
            /// The focused field, where the dictation goes: its text with `caretMarker` at the caret.
            case heading, text, link, row, field, caret
        }
        var kind: Kind
        var text: String
        /// Where it is on screen (Accessibility coordinates, y down), when the app reports it.
        var frame: CGRect? = nil
        /// Private contiguous recognition source; removed by shared finalization.
        var source: [String]? = nil
        var runs: [SharedSemanticText.Run]? = nil

        /// Text that flows within a line; headings, rows, fields and the caret block start their own.
        var isInline: Bool { kind == .text || kind == .link }
    }

    /// Already redacted and projected by shared Rust; never holds native source.
    var terminalViewport: JSON?
    var appName: String
    var bundleID: String?
    var windowTitle: String?
    /// Host of the web page (browsers and web-based apps).
    var host: String?
    /// Legacy optional wire field; native viewport acquisition leaves it unavailable.
    var terminalProgram: String?
    var focusedRole: String?
    var textBeforeCaret = ""
    var selectedText = ""
    /// Acquisition could not prove that the entire selection was retained. Disables Edit.
    var selectionUnavailable = false
    var textAfterCaret = ""
    var blocks: [Block] = []
    var nodesVisited = 0
    var coreFailed = false
    var sourceBytes: Int?
    var textBudgetFull = false
    mutating func prepareTextBudget() {
        guard sourceBytes == nil, !coreFailed else { return }
        do {
            let result = try SharedContext.reserveCaret([textBeforeCaret, selectedText, textAfterCaret])
            sourceBytes = result.used; textBudgetFull = result.budgetFull
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
    }
    /// Why the walk stopped before covering the window, if it did.
    var stoppedEarly: String?
    var seconds: Double = 0

    /// Marks the caret in rendered text.
    static let caretMarker = "‸"

    /// Places the focused field at its spot in the reading order: the text around the caret with
    /// the caret marked (a selection is bracketed by markers).
    mutating func appendCaret(frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed else { return }
        let caret = selectedText.isEmpty ? Self.caretMarker : Self.caretMarker + selectedText + Self.caretMarker
        blocks.append(Block(kind: .caret, text: textBeforeCaret + caret + textAfterCaret, frame: frame))
    }

    /// Adds visible text, skipping blanks and the repeats accessibility trees are full of (a link
    /// titled "Inbox" whose child text is also "Inbox").
    mutating func append(_ kind: Block.Kind, _ text: String, frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed, let used = sourceBytes else { return }
        do {
            let result = try SharedContext.admit(text, previous: blocks.last?.kind == .caret ? nil : blocks.last?.text, used: used)
            sourceBytes = result.used; textBudgetFull = result.budgetFull
            if textBudgetFull { stoppedEarly = "text budget" }
            if !result.text.isEmpty { blocks.append(Block(kind: kind, text: result.text, frame: frame)) }
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
    }

    mutating func appendSemantic(_ kind: Block.Kind, _ source: SharedSemanticText.Projection, frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed, let used = sourceBytes else { return }
        do {
            let result = try SharedContext.admitSemantic(source, kind: kind, used: used, previous: blocks.last)
            sourceBytes = result.used; textBudgetFull = result.budgetFull
            if textBudgetFull { stoppedEarly = "text budget" }
            if !result.text.isEmpty { blocks.append(Block(kind: kind, text: result.text, frame: frame, runs: result.runs)) }
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
    }

    mutating func appendField(_ parts: [String], frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed, let used = sourceBytes else { return }
        do {
            let result = try SharedContext.admitField(parts, used: used)
            sourceBytes = result.used; textBudgetFull = result.budgetFull
            if textBudgetFull { stoppedEarly = "text budget" }
            if !result.parts[1].isEmpty {
                blocks.append(Block(kind: .field, text: result.parts[1], frame: frame, source: result.parts))
            }
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
    }

    /// The visible text laid out as on screen: text and links side by side on one line are joined
    /// (a chat message's author and time), everything else starts a line, and a jump back up the
    /// window (the next pane or column) leaves a blank line. Headings are marked, links bracketed,
    /// row cells joined.
    func renderedText() throws -> String {
        guard !coreFailed else { throw Redactor.Failure.refused }
        if let terminalViewport, let rendered = terminalViewport["renderedText"]?.string { return rendered }
        let caret = blocks.contains(where: { $0.source != nil || $0.runs != nil }) ? [textBeforeCaret, selectedText, textAfterCaret] : nil
        return try SharedContext.process(blocks: blocks, caret: caret).rendered
    }

    /// Whether an element can show its text. Web apps keep hidden text in the tree in boxes at most
    /// a point thin: screen-reader-only labels, list items scrolled out of view (Chromium clips
    /// them to 0×1 at the list's edge), hover-only actions. A 0×0 frame says nothing (an app
    /// that reports no size), so it counts as shown.
    static func isShown(_ frame: CGRect) -> Bool {
        guard frame.width > 0 || frame.height > 0 else { return true }
        return min(frame.width, frame.height) > HelperConfig.contextHiddenMaxThickness
    }

    /// Sizes and timings only, safe to log.
    var summary: String {
        let counts = Dictionary(grouping: blocks, by: \.kind).mapValues(\.count)
        let visible = blocks.reduce(0) { $0 + $1.text.count }
        return "app \(bundleID ?? appName), host \(host ?? "-"), program \(terminalProgram ?? "-"), "
            + "focused \(focusedRole ?? "-"), title \(windowTitle?.count ?? 0) chars, "
            + "caret \(textBeforeCaret.count)/\(selectedText.count)/\(textAfterCaret.count) chars, "
            + "\(blocks.count) blocks (\(counts[.heading] ?? 0) headings, \(counts[.row] ?? 0) rows, "
            + "\(counts[.link] ?? 0) links, \(counts[.field] ?? 0) fields, caret placed \(counts[.caret] != nil)) \(visible) chars, "
            + "\(nodesVisited) nodes, \(Int(seconds * 1000)) ms" + (stoppedEarly.map { ", stopped: \($0)" } ?? "")
    }

    /// Everything read, for the debug log file (`Log.content`): the fields, the text around the caret
    /// and the visible text as the prompts receive it.
    var logDescription: String {
        get throws {
        "app \(appName) (\(bundleID ?? "-")), window title \(windowTitle ?? "-"), host \(host ?? "-"), "
            + "terminal program \(terminalProgram ?? "-"), focused \(focusedRole ?? "-")"
            + (stoppedEarly.map { ", stopped: \($0)" } ?? "") + "\n"
            + "--- text before the caret ---\n\(textBeforeCaret)\n"
            + "--- selected text ---\n\(selectedText)\n"
            + "--- text after the caret ---\n\(textAfterCaret)\n"
            + "--- visible text ---\n\(try renderedText())"
    }
    }

    /// The first line whose top is at or below `windowTop`, by binary search over lines whose
    /// tops increase down the text (a terminal's scrollback). Nil when every line is above it.
    static func firstVisibleLine(lineCount: Int, windowTop: CGFloat, lineTop: (Int) -> CGFloat?) -> Int? {
        var low = 0
        var high = lineCount
        while low < high {
            let mid = (low + high) / 2
            guard let top = lineTop(mid) else { return nil }
            if top < windowTop { low = mid + 1 } else { high = mid }
        }
        return low < lineCount ? low : nil
    }

}
