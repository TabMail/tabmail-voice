// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI
import Testing
@testable import TabMailVoice

/// The Space hint as drawn: a dark tooltip, in light and dark mode alike, with an arrow up at the
/// pill, saying what Space switches to.
@MainActor
struct ModeHintTests {
    private let scale: CGFloat = 2

    @Test func saysWhatSpaceSwitchesTo() {
        #expect(ModeHint(mode: .dictation).action == "agent mode")
        #expect(ModeHint(mode: .agent).action == "exit agent")
    }

    /// As tall as its arrow and box, the room `OverlayPanelController.opensUpward` leaves for it.
    @Test(arguments: [DictationMode.dictation, .agent])
    func takesTheRoomLeftForIt(mode: DictationMode) {
        let size = NSHostingView(rootView: ModeHint(mode: mode)).fittingSize
        #expect(size.height == DictationConfig.modeHintArrowHeight + DictationConfig.modeHintHeight)
        #expect(size.width > size.height)
    }

    @Test(arguments: [DictationMode.dictation, .agent], [ColorScheme.light, .dark])
    func isADarkTooltipWithAnArrowUpAtThePill(mode: DictationMode, scheme: ColorScheme) throws {
        let hint = try render(mode, scheme)
        let width = CGFloat(hint.pixelsWide) / scale
        let arrow = DictationConfig.modeHintArrowHeight
        let boxMiddle = arrow + DictationConfig.modeHintHeight / 2

        // The box, left of the keycap, and the arrow's tip at the top centre: dark and opaque.
        for (x, y) in [(3, boxMiddle), (width - 3, boxMiddle), (width / 2, arrow - 1)] {
            let (white, alpha) = pixel(hint, x, y)
            #expect(white < 0.3, "not dark at \(x), \(y)")
            #expect(alpha > 0.8, "not opaque at \(x), \(y)")
        }
        // Beside the arrow, above the box: nothing drawn.
        for x in [width / 4, width * 3 / 4] {
            #expect(pixel(hint, x, 1).alpha < 0.5, "drawn beside the arrow at \(x)")
        }
    }

    private func render(_ mode: DictationMode, _ scheme: ColorScheme) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: ModeHint(mode: mode).environment(\.colorScheme, scheme))
        renderer.scale = scale
        return NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    }

    /// Brightness and opacity at a point, in points from the top left.
    private func pixel(_ bitmap: NSBitmapImageRep, _ x: CGFloat, _ y: CGFloat) -> (white: CGFloat, alpha: CGFloat) {
        guard let colour = bitmap.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.genericGray) else { return (1, 0) }
        return (colour.whiteComponent, colour.alphaComponent)
    }
}
