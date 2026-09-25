// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import CoreGraphics
import Testing
@testable import TabMail

@MainActor
struct OverlayGeometryTests {
    private let canvas = CGSize(width: 200, height: 60)
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

    @Test func sitsCentredJustBelowTheCaretLine() {
        let caret = CGRect(x: 500, y: 400, width: 1, height: 20)
        let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, visibleFrame: screen)
        #expect(origin.x == caret.midX - canvas.width / 2)
        #expect(origin.y + canvas.height <= caret.minY)
    }

    @Test func movesAboveTheCaretWhenThereIsNoRoomBelow() {
        let caret = CGRect(x: 500, y: 10, width: 1, height: 20)
        let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, visibleFrame: screen)
        #expect(origin.y >= caret.maxY)
    }

    @Test func staysOnScreenAtTheEdges() {
        for caret in [CGRect(x: 2, y: 400, width: 1, height: 20), CGRect(x: 998, y: 790, width: 1, height: 20)] {
            let origin = OverlayPanelController.overlayOrigin(anchor: caret, canvas: canvas, visibleFrame: screen)
            let frame = CGRect(origin: origin, size: canvas)
            #expect(screen.contains(frame))
        }
    }
}
