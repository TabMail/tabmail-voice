// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// What was on screen when a dictation started: the app, where in it, the text around the caret
/// and the visible text in reading order, laid out in lines as on screen. User content: never stored,
/// and sent only through the shared core's reply (`json`), which redacts and renders it (ADR-DESK-054).
struct ScreenContext: Sendable, Equatable {
    struct Block: Sendable, Equatable {
        enum Kind: String, Sendable {
            /// The focused field, where the dictation goes: the core renders it from the caret's parts.
            case heading, text, link, row, field, caret
        }
        var kind: Kind
        var text: String
        /// Where it is on screen (Accessibility coordinates, y down), when the app reports it.
        var frame: CGRect? = nil
        /// Private contiguous recognition source; removed by shared finalization.
        var source: [String]? = nil
        var runs: [SharedSemanticText.Run]? = nil
    }

    /// A terminal's viewport source, as acquired: private until the shared core projects and redacts
    /// it in the reply.
    var terminalSource: JSON?
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
            hiddenMarker = try SharedContext.hiddenMarker()
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
    }
    /// What stands in for a part withheld for privacy (a field that frames a page of an excluded
    /// website, or an element read in one piece too large to look through for one): the shared
    /// core's, read with the text budget.
    var hiddenMarker = ""
    /// Why the walk stopped before covering the window, if it did.
    var stoppedEarly: String?
    var seconds: Double = 0

    /// Places the focused field at its spot in the reading order; the core renders it from the
    /// text around the caret.
    mutating func appendCaret(frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed else { return }
        blocks.append(Block(kind: .caret, text: "", frame: frame))
    }

    /// Adds visible text, skipping blanks and the repeats accessibility trees are full of (a link
    /// titled "Inbox" whose child text is also "Inbox").
    mutating func append(_ kind: Block.Kind, _ text: String, frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed, let used = sourceBytes else { return }
        do {
            let result = try SharedContext.admit(text, previous: blocks.last?.kind == .caret ? nil : blocks.last?.text, used: used)
            sourceBytes = result.used; textBudgetFull = result.budgetFull
            if let stop = result.stop { stoppedEarly = stop }
            if !result.text.isEmpty { blocks.append(Block(kind: kind, text: result.text, frame: frame)) }
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
    }

    mutating func appendSemantic(_ kind: Block.Kind, _ source: SharedSemanticText.Projection, frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed, let used = sourceBytes else { return }
        do {
            let result = try SharedContext.admitSemantic(source, kind: kind, used: used, previous: blocks.last)
            sourceBytes = result.used; textBudgetFull = result.budgetFull
            if let stop = result.stop { stoppedEarly = stop }
            if !result.text.isEmpty { blocks.append(Block(kind: kind, text: result.text, frame: frame, runs: result.runs)) }
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
    }

    mutating func appendField(_ parts: [String], frame: CGRect? = nil) {
        prepareTextBudget()
        guard !coreFailed, let used = sourceBytes else { return }
        do {
            let result = try SharedContext.admitField(parts, used: used)
            sourceBytes = result.used; textBudgetFull = result.budgetFull
            if let stop = result.stop { stoppedEarly = stop }
            if !result.parts[1].isEmpty {
                blocks.append(Block(kind: .field, text: result.parts[1], frame: frame, source: result.parts))
            }
        } catch { coreFailed = true; stoppedEarly = "shared core refused" }
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
