// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Testing
@testable import VoiceMacOSKit

/// Where the caret is taken to be, from what apps answer.
struct CaretLocatorTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)

    /// Accessibility reports top-left-origin rects; the overlay is placed in bottom-left-origin
    /// screen space. A caret 100 pt below the top of an 800 pt screen sits 700 pt above the bottom.
    @Test func flipsAccessibilityRectsIntoScreenCoordinates() {
        let caret = CaretLocator.cocoaRect(
            fromAccessibility: CGRect(x: 50, y: 80, width: 1, height: 20),
            primaryScreenHeight: 800
        )
        #expect(caret == CGRect(x: 50, y: 700, width: 1, height: 20))
    }

    /// Chromium at the start of a field and terminals at a wrapped line return the line's box;
    /// the overlay must anchor at its leading edge, not its middle. Real carets pass through.
    @Test func aLineBoxAnchorsAtItsLeadingEdge() {
        let lineBox = CGRect(x: 300, y: 268, width: 713, height: 20)
        let anchored = CaretLocator.caretEdge(of: lineBox)
        #expect(anchored.midX == lineBox.minX)
        #expect(anchored.minY == lineBox.minY && anchored.height == lineBox.height)

        let caret = CGRect(x: 304, y: 270, width: 0, height: 16)
        #expect(CaretLocator.caretEdge(of: caret) == caret)
    }

    /// Chromium gives a plain-text Gmail caret on an empty line the whole field's box, and no
    /// other place but its line number. Measured: text on lines 0-18 from 741 to 1107, 15 high,
    /// 19.5 apart; the empty line 7 is at 877.5. A box one line tall is kept.
    @Test func aCaretGivenABlocksBoxIsPutOnItsLine() {
        let field = CGRect(x: 1821, y: 739, width: 568, height: 416)
        let text = CaretLocator.TextLines(top: 741, bottom: 1107, lineHeight: 15, firstLine: 0, lastLine: 18)
        #expect(CaretLocator.caretLine(in: field, line: 7, text: text) == CGRect(x: 1821, y: 877.5, width: 0, height: 15))
        #expect(CaretLocator.caretLine(in: field, line: 0, text: text).minY == 741)
        // Text that starts lower down is measured from its own first line.
        let lower = CaretLocator.TextLines(top: 780, bottom: 1107, lineHeight: 15, firstLine: 2, lastLine: 18)
        #expect(CaretLocator.caretLine(in: field, line: 7, text: lower).minY == 877.5)
        #expect(CaretLocator.caretLine(in: field, line: 0, text: lower).minY == 741)
        let block = CGRect(x: 1821, y: 837, width: 568, height: 156)
        #expect(CaretLocator.caretLine(in: block, line: 6, text: text).minY == 858)

        let oneLine = CGRect(x: 1821, y: 876, width: 568, height: 19)
        #expect(CaretLocator.caretLine(in: oneLine, line: 7, text: text) == oneLine)
        // One line of text says nothing of the spacing.
        let single = CaretLocator.TextLines(top: 741, bottom: 756, lineHeight: 15, firstLine: 0, lastLine: 0)
        #expect(CaretLocator.caretLine(in: field, line: 2, text: single) == field)
        #expect(CaretLocator.caretLine(in: field, line: -1, text: text) == field)
    }

    /// A rich-text caret on an empty line gets its block's box (measured in Chromium: a signature
    /// block of two empty lines, "--" and a name, 80 high at 462). The caret is on the line after
    /// the breaks before it in the block; Chromium's own line number for a caret at the block's
    /// start is the line above the block.
    @Test func aCaretInABlocksBoxIsPutOnItsLineInTheBlock() {
        let block = CGRect(x: 79, y: 462, width: 500, height: 80)
        let text = "\n\n--\nSynthetic signature"
        #expect(CaretLocator.caretLine(in: block, before: "", text: text, textHeights: [16, 16]) == CGRect(x: 79, y: 462, width: 0, height: 20))
        #expect(CaretLocator.caretLine(in: block, before: "\n", text: text, textHeights: [16, 16])?.minY == 482)
        // A last break adds no line: an empty paragraph is one line.
        #expect(CaretLocator.caretLine(in: CGRect(x: 79, y: 502, width: 500, height: 20), before: "", text: "\n", textHeights: [])
            == CGRect(x: 79, y: 502, width: 0, height: 20))
        // Wrapped text has more lines than breaks; a block with no text says nothing.
        #expect(CaretLocator.caretLine(in: block, before: "\n", text: text, textHeights: [16, 36]) == nil)
        #expect(CaretLocator.caretLine(in: block, before: "", text: "", textHeights: []) == nil)
    }

    /// iTerm2's caret index counts trailing spaces its line text drops (measured: index 98997 on
    /// line 98878+117, whose line-break cell is at x 4117, 8 pt cells): the caret is 3 cells
    /// right of the line break, not on the next line and not clamped onto the break.
    @Test func aTerminalCaretPastTrailingSpacesStepsRightByCells() {
        let breakCell = CGRect(x: 4117, y: 1307, width: 8, height: 16)
        let line = CFRange(location: 98_878, length: 117)
        let lineEnd = line.location + line.length - 1
        #expect(CaretLocator.cellsRight(of: breakCell, by: 98_997 - lineEnd) == CGRect(x: 4141, y: 1307, width: 0, height: 16))
        // An index before the line (other drift) comes back to the line's start.
        #expect(CaretLocator.clamp(98_800, into: line) == 98_878)
        #expect(CaretLocator.clamp(98_900, into: line) == 98_900)
    }

    /// Placeholder rects some apps return instead of an error must not anchor the overlay.
    @Test func rejectsPlaceholderAndOffScreenRects() {
        let screens = [screen, CGRect(x: 1000, y: 0, width: 800, height: 600)]
        #expect(CaretLocator.isPlausible(CGRect(x: 500, y: 400, width: 1, height: 20), screens: screens))
        #expect(CaretLocator.isPlausible(CGRect(x: 1200, y: 300, width: 1, height: 20), screens: screens))
        #expect(!CaretLocator.isPlausible(CGRect(x: 0, y: 0, width: 1, height: 20), screens: screens))
        #expect(!CaretLocator.isPlausible(CGRect(x: 500, y: 400, width: 1, height: 0), screens: screens))
        #expect(!CaretLocator.isPlausible(CGRect(x: -5000, y: 400, width: 1, height: 20), screens: screens))
    }
}
