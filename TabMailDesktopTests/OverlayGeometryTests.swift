// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import CoreGraphics
import Testing
@testable import TabMail

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
    }

    @Test func pillStaysOnScreenAtTheEdges() {
        for caret in [CGRect(x: 2, y: 400, width: 1, height: 20), CGRect(x: 998, y: 790, width: 1, height: 20)] {
            let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, pillHeight: pillHeight, visibleFrame: screen)
            #expect(screen.contains(pillFrame(origin)))
        }
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
