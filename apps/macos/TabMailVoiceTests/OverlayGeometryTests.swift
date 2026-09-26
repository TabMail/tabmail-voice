// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import CoreGraphics
import Testing
@testable import TabMailVoice

@MainActor
struct OverlayGeometryTests {
    private let canvas = CGSize(width: 200, height: 60)
    private let pillHeight: CGFloat = 30
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

    /// Where the pill itself lands: centred vertically in the canvas (one line tall).
    private func pillFrame(_ origin: CGPoint) -> CGRect {
        CGRect(x: origin.x, y: origin.y + (canvas.height - pillHeight) / 2, width: canvas.width, height: pillHeight)
    }

    /// The pill's top edge sits exactly the configured gap below the caret's line — not the
    /// transparent canvas's edge, which would leave the pill visibly lower.
    @Test func pillSitsJustBelowTheCaretLine() {
        let caret = CGRect(x: 500, y: 400, width: 1, height: 20)
        let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, pillHeight: pillHeight, visibleFrame: screen)
        #expect(origin.x == caret.midX - canvas.width / 2)
        #expect(pillFrame(origin).maxY == caret.minY - DictationConfig.overlayCaretGap)
    }

    @Test func movesAboveTheCaretWhenThereIsNoRoomBelow() {
        let caret = CGRect(x: 500, y: 10, width: 1, height: 20)
        let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, pillHeight: pillHeight, visibleFrame: screen)
        #expect(pillFrame(origin).minY == caret.maxY + DictationConfig.overlayCaretGap)
        #expect(OverlayPanelController.opensUpward(anchor: caret, pillHeight: pillHeight, visibleFrame: screen))
        #expect(!OverlayPanelController.opensUpward(anchor: CGRect(x: 500, y: 400, width: 1, height: 20), pillHeight: pillHeight, visibleFrame: screen))
    }

    /// The Space hint shows under the listening pill for a moment every hold. With the caret near the
    /// bottom of the screen, the overlay opens below the caret's line only when the hint fits on
    /// screen under the pill, and above it only when it wouldn't.
    @Test func opensBelowTheCaretOnlyWhenTheHintFitsUnderThePill() {
        let canvas = DictationConfig.overlayCanvasSize
        let pillHeight = DictationConfig.pillHeight
        var openedBelow = 0
        for bottom in stride(from: screen.minY, through: screen.minY + 150, by: 1) {
            let caret = CGRect(x: 500, y: bottom, width: 1, height: 16)
            let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, pillHeight: pillHeight, visibleFrame: screen)
            // As `PillLayout` places it: the pill's top where a one-line pill centred in the canvas has it.
            let pillTop = origin.y + canvas.height - (canvas.height - pillHeight) / 2
            let hintBelowCaret = caret.minY - DictationConfig.overlayCaretGap - DictationConfig.listeningPillHeight - DictationConfig.modeHintFootprint
            if pillTop <= caret.minY {
                openedBelow += 1
                #expect(pillTop - DictationConfig.listeningPillHeight - DictationConfig.modeHintFootprint >= screen.minY, "hint off screen for a caret at \(bottom)")
            } else {
                #expect(hintBelowCaret < screen.minY, "opened above for a caret at \(bottom) with room below")
            }
        }
        #expect(openedBelow > 0)
    }

    @Test func pillStaysOnScreenAtTheEdges() {
        for caret in [CGRect(x: 2, y: 400, width: 1, height: 20), CGRect(x: 998, y: 790, width: 1, height: 20)] {
            let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, pillHeight: pillHeight, visibleFrame: screen)
            #expect(screen.contains(pillFrame(origin)))
        }
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

    /// Agent mode's bubbles and the Space hint (top-left origin), in the overlay's canvas: the bubbles
    /// in one row centred above the pill, clear of it and of each other; the hint a tooltip centred
    /// under the pill; nothing overlaps and everything stays inside the canvas. For the listening pill
    /// and the circle it shrinks to, with no bubbles (dictation) and as many as are ever offered.
    @Test func bubblesSitInARowAboveThePillAndTheHintUnderIt() {
        let canvas = CGRect(origin: .zero, size: DictationConfig.overlayCanvasSize)
        let bubble = CGSize(width: DictationConfig.agentBubbleDiameter, height: DictationConfig.agentBubbleDiameter)
        let hint = CGSize(width: 90, height: DictationConfig.modeHintArrowHeight + DictationConfig.modeHintHeight)
        func frame(_ centre: CGPoint, _ size: CGSize) -> CGRect {
            CGRect(x: centre.x - size.width / 2, y: centre.y - size.height / 2, width: size.width, height: size.height)
        }
        for width in [79, DictationConfig.pillHeight] {
            let pill = CGRect(x: canvas.midX - width / 2, y: (canvas.height - DictationConfig.pillHeight) / 2, width: width, height: DictationConfig.pillHeight)
            let hintFrame = frame(OverlayPanelController.hintCentre(under: pill, size: hint), hint)
            #expect(hintFrame.minY >= pill.maxY)
            #expect(abs(hintFrame.midX - pill.midX) < 0.001, "hint not centred under the pill")
            #expect(canvas.contains(hintFrame))
            // Edit and Compose are never offered together: one fewer bubble than there are tools.
            for count in 0...(AgentTool.allCases.count - 1) {
                let centres = OverlayPanelController.bubbleCentres(above: pill, sizes: Array(repeating: bubble, count: count))
                #expect(centres.count == count)
                let frames = centres.map { frame($0, bubble) }
                for (index, bubbleFrame) in frames.enumerated() {
                    #expect(bubbleFrame.maxY <= pill.minY, "bubble \(index) of \(count) is not above the pill")
                    #expect(!bubbleFrame.intersects(hintFrame), "bubble \(index) of \(count) overlaps the hint")
                    #expect(canvas.contains(bubbleFrame))
                    for other in frames[(index + 1)...] { #expect(!bubbleFrame.intersects(other), "bubbles overlap (\(count))") }
                }
                if let first = frames.first, let last = frames.last {
                    #expect(abs((first.minX + last.maxX) / 2 - pill.midX) < 0.001, "row not centred over the pill (\(count))")
                }
            }
        }
    }
}
