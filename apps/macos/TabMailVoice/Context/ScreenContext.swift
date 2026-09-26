// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// What was on screen when a dictation started: the app, where in it, the text around the caret
/// and the visible text in reading order. User content: never logged or stored (see `summary`).
struct ScreenContext: Sendable, Equatable {
    struct Block: Sendable, Equatable {
        enum Kind: String, Sendable {
            /// The focused field, where the dictation goes: its text with `caretMarker` at the caret.
            case heading, text, link, row, field, caret
        }
        var kind: Kind
        var text: String
    }

    var appName: String
    var bundleID: String?
    var windowTitle: String?
    /// Host of the web page (browsers and web-based apps).
    var host: String?
    /// Foreground program of the terminal's active tmux pane.
    var terminalProgram: String?
    var focusedRole: String?
    var textBeforeCaret = ""
    var selectedText = ""
    var textAfterCaret = ""
    var blocks: [Block] = []
    var nodesVisited = 0
    /// Why the walk stopped before covering the window, if it did.
    var stoppedEarly: String?
    var seconds: Double = 0

    /// Marks the caret in rendered text.
    static let caretMarker = "‸"

    /// Places the focused field at its spot in the reading order: the text around the caret with
    /// the caret marked (a selection is bracketed by markers).
    mutating func appendCaret() {
        let caret = selectedText.isEmpty ? Self.caretMarker : Self.caretMarker + selectedText + Self.caretMarker
        blocks.append(Block(kind: .caret, text: textBeforeCaret + caret + textAfterCaret))
    }

    /// Adds visible text, skipping blanks and the repeats accessibility trees are full of (a link
    /// titled "Inbox" whose child text is also "Inbox").
    mutating func append(_ kind: Block.Kind, _ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != blocks.last?.text else { return }
        blocks.append(Block(kind: kind, text: trimmed))
    }

    /// The visible text as plain lines: headings marked, links bracketed, row cells joined.
    func renderedText() -> String {
        blocks.map { block in
            switch block.kind {
            case .heading: "## \(block.text)"
            case .link: "[\(block.text)]"
            case .row: "| \(block.text)"
            case .field: block.text.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
            case .caret: block.text.split(separator: "\n", omittingEmptySubsequences: false).map { "» \($0)" }.joined(separator: "\n")
            case .text: block.text
            }
        }
        .joined(separator: "\n")
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

    /// Up to `maxChars` on each side of the selection. Accessibility ranges count UTF-16 units;
    /// the cuts are widened so no character (emoji, accented letter) is split.
    static func caretWindow(in text: String, selection: NSRange, maxChars: Int) -> (before: String, selected: String, after: String) {
        let string = text as NSString
        let start = min(max(selection.location, 0), string.length)
        let end = min(start + max(selection.length, 0), string.length)
        func whole(_ range: NSRange) -> String {
            range.length > 0 ? string.substring(with: string.rangeOfComposedCharacterSequences(for: range)) : ""
        }
        let beforeStart = max(0, start - maxChars)
        return (
            whole(NSRange(location: beforeStart, length: start - beforeStart)),
            whole(NSRange(location: start, length: end - start)),
            whole(NSRange(location: end, length: min(maxChars, string.length - end)))
        )
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

    /// The active pane of a tmux client: where the user is typing and where its cursor is.
    struct TmuxPane: Equatable {
        var id: String
        var tty: String
        var cursorX: Int
        var cursorY: Int

        /// The `tmux list-clients -F` format `activePane(fromTmuxClients:)` parses.
        static let clientFormat = "#{client_activity} #{pane_id} #{pane_tty} #{cursor_x} #{cursor_y}"
    }

    /// The pane of the most recently active tmux client (the terminal the user is typing in).
    static func activePane(fromTmuxClients output: String) -> TmuxPane? {
        output.split(separator: "\n")
            .compactMap { line -> (Int, TmuxPane)? in
                let parts = line.split(separator: " ")
                guard parts.count == 5, let activity = Int(parts[0]), let x = Int(parts[3]), let y = Int(parts[4]) else { return nil }
                return (activity, TmuxPane(id: String(parts[1]), tty: String(parts[2]), cursorX: x, cursorY: y))
            }
            .max { $0.0 < $1.0 }?.1
    }

    /// Splits a pane's visible text (`tmux capture-pane -p`) at the cursor cell. Columns count
    /// characters, so a wide (CJK, emoji) character before the cursor on its line shifts it by one.
    static func splitAtCursor(_ screen: String, line: Int, column: Int) -> (before: String, after: String) {
        var lines = screen.components(separatedBy: "\n")
        while lines.count > line + 1, lines.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeLast() }
        guard line < lines.count else { return (lines.joined(separator: "\n"), "") }
        let current = lines[line].padding(toLength: max(lines[line].count, column), withPad: " ", startingAt: 0)
        let cut = current.index(current.startIndex, offsetBy: column)
        let before = (lines[..<line] + [String(current[..<cut])]).joined(separator: "\n")
        let after = ([String(current[cut...])] + lines[(line + 1)...]).joined(separator: "\n")
        return (before, after)
    }

    /// Whether the tmux pane is what the terminal in front shows: most of the pane's non-blank
    /// lines appear in the terminal's text (side by side with other panes, so as substrings).
    /// A tmux attached in another tab or window fails this.
    static func paneIsOnScreen(pane: String, screen: String, sampleLines: Int, requiredShare: Double) -> Bool {
        let lines = pane.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .suffix(sampleLines)
        guard !lines.isEmpty else { return false }
        let found = lines.filter { screen.contains($0) }.count
        return Double(found) >= Double(lines.count) * requiredShare
    }

    /// From `ps -o pid=,tpgid=,comm= -t <tty>`: the terminal's foreground process-group leader.
    static func foregroundProgram(fromPS output: String) -> String? {
        for line in output.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
            guard parts.count == 3, parts[0] == parts[1] else { continue }
            return (String(parts[2]) as NSString).lastPathComponent
        }
        return nil
    }
}
