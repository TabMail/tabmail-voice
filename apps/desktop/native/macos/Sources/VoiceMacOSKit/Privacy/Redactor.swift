// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// One kind of secret-looking text and what replaces it (ADR-DESK-046). The list (`Redactor.all`)
/// is generated from `native/shared/privacy/redactors.json`, the one definition every platform's
/// helper shares, and checked against `redaction-cases.json`.
struct Redactor: Sendable {
    let name: String
    let regex: NSRegularExpression
    /// What a match becomes: `$1`, `$2` are the pattern's groups.
    let replacement: String

    init(name: String, pattern: String, ignoreCase: Bool, replacement: String) {
        self.name = name
        // The patterns are generated and checked by the tests: one that doesn't compile is a build defect.
        regex = try! NSRegularExpression(pattern: pattern, options: ignoreCase ? [.caseInsensitive] : [])
        self.replacement = replacement
    }

    /// `text` with what looks like a secret replaced: every redactor, in order. A safety net for
    /// text read off the screen: it catches the common shapes, not every secret.
    static func redact(_ text: String) -> String {
        redact([[text]])[0][0]
    }

    /// Each text of `lines` with what looks like a secret replaced. A line is one or more texts that
    /// follow one another with nothing between them (the text before the caret, the selection, the
    /// text after it); the lines are redacted as the one text they make together, a line break
    /// between them. So a secret is found whether one text holds it whole (a key in a terminal) or it
    /// is spread over several (a key's lines, one element each; `Bearer` and its token; a name and its
    /// value, the name ending in its `=` or `:`, in two elements; a key the caret is inside).
    ///
    /// Each text keeps its share of the result. Of a match, what the replacement starts with as the
    /// match does (the character before a key, a name, the word Bearer) stays in the texts that held
    /// it. The rest of the replacement, up to what it ends with as the match does (the `@` after an
    /// address's password), goes to the text the rest of the match began in; every later boundary
    /// between texts in the match lands before that kept end, so a text wholly inside the secret
    /// comes back empty.
    ///
    /// A redactor the regex engine could not finish (it reports an internal error, and without the
    /// asking would stop silently) withholds everything after its last match.
    static func redact(_ lines: [[String]], with redactors: [Redactor] = all) -> [[String]] {
        var text = lines.map { $0.joined() }.joined(separator: "\n") as NSString
        // Where each text starts and ends in `text`, in UTF-16 units.
        var ranges: [[(start: Int, end: Int)]] = []
        var position = 0
        for line in lines {
            var places: [(start: Int, end: Int)] = []
            for item in line {
                let length = (item as NSString).length
                places.append((position, position + length))
                position += length
            }
            ranges.append(places)
            position += 1
        }
        for redactor in redactors {
            var matches: [NSTextCheckingResult] = []
            var finished = true
            redactor.regex.enumerateMatches(in: text as String, options: [.reportCompletion], range: NSRange(location: 0, length: text.length)) { match, flags, _ in
                if let match { matches.append(match) }
                if flags.contains(.internalError) { finished = false }
            }
            if matches.isEmpty, finished { continue }
            let result = NSMutableString()
            // Each match's place in the old text, its replacement's place in the new one, and how
            // much of the match the replacement starts and ends with.
            var edits: [(start: Int, end: Int, newStart: Int, newEnd: Int, kept: (start: Int, end: Int))] = []
            var copied = 0
            for match in matches {
                result.append(text.substring(with: NSRange(location: copied, length: match.range.location - copied)))
                let newStart = result.length
                let replacement = redactor.regex.replacementString(for: match, in: text as String, offset: 0, template: redactor.replacement)
                result.append(replacement)
                edits.append((match.range.location, NSMaxRange(match.range), newStart, result.length, kept(of: text.substring(with: match.range), in: replacement)))
                copied = NSMaxRange(match.range)
            }
            if finished {
                result.append(text.substring(from: copied))
            } else {
                HelperLog.debug("Redactor: \(redactor.name) could not finish; the text after its last match is withheld")
                let newStart = result.length
                result.append(placeholder)
                edits.append((copied, text.length, newStart, result.length, (0, 0)))
            }
            func moved(_ place: Int) -> Int {
                var shift = 0
                for edit in edits {
                    if place <= edit.start { break }
                    if place < edit.end {
                        if place - edit.start <= edit.kept.start { return edit.newStart + place - edit.start }
                        return edit.newEnd - edit.kept.end
                    }
                    shift = edit.newEnd - edit.end
                }
                return place + shift
            }
            ranges = ranges.map { $0.map { (moved($0.start), moved($0.end)) } }
            text = result
        }
        return ranges.map { $0.map { text.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) } }
    }

    /// How many UTF-16 units `replacement` starts with as `match` does, and ends with as it does,
    /// the two not overlapping in either.
    static func kept(of match: String, in replacement: String) -> (start: Int, end: Int) {
        let old = Array(match.utf16), new = Array(replacement.utf16)
        let shorter = min(old.count, new.count)
        var start = 0
        while start < shorter, old[start] == new[start] { start += 1 }
        var end = 0
        while end < shorter - start, old[old.count - 1 - end] == new[new.count - 1 - end] { end += 1 }
        return (start, end)
    }
}

extension ScreenContext {
    /// The context with secret-looking text taken out of everything read off the screen: the
    /// window's title, and the visible blocks and the text around the caret, redacted together
    /// (`Redactor.redact(_:)` of several lines). The focused field's block is its three texts, put
    /// together again with the caret marked. A block left empty (a line inside a key) is dropped; the
    /// caret's block stays.
    var redacted: ScreenContext {
        var context = self
        context.windowTitle = windowTitle.map(Redactor.redact)
        let caret = [textBeforeCaret, selectedText, textAfterCaret]
        let hasCaretBlock = blocks.contains { $0.kind == .caret }
        // Without a block for the focused field (a walk that stopped before it), its texts follow
        // the blocks.
        let lines = Redactor.redact(blocks.map { $0.kind == .caret ? caret : [$0.text] } + (hasCaretBlock ? [] : [caret]))
        let around = hasCaretBlock ? zip(blocks, lines).first { $0.0.kind == .caret }!.1 : lines[blocks.count]
        context.textBeforeCaret = around[0]
        // A selection the redaction left empty or blank is still a selection (`selectionRedacted`):
        // the app takes a blank one for none, and would paste over the real one.
        let blank = around[1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        context.selectedText = blank && around[1] != selectedText ? Redactor.placeholder : around[1]
        context.textAfterCaret = around[2]
        context.blocks = []
        for (block, line) in zip(blocks, lines) {
            if block.kind == .caret {
                context.appendCaret(frame: block.frame)
            } else if !line[0].isEmpty {
                context.blocks.append(Block(kind: block.kind, text: line[0], frame: block.frame))
            }
        }
        return context
    }
}
