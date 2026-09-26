// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI
import Testing
@testable import TabMailVoice

/// Agent mode's tool bubbles as drawn: the running tool's bubble is clearly the larger one, grown
/// upward, away from the pill below.
@MainActor
struct ToolBubbleTests {
    private let scale: CGFloat = 2
    /// Room around the bubble, so a grown bubble is drawn whole.
    private let room: CGFloat = 80

    @Test(arguments: [AgentTool.edit, .compose])
    func theRunningToolsBubbleIsDrawnLarger(tool: AgentTool) throws {
        let idle = try drawnCircle(ToolBubble(tool: tool, appURL: nil, isRunning: false, isDimmed: false))
        let running = try drawnCircle(ToolBubble(tool: tool, appURL: nil, isRunning: true, isDimmed: false))

        #expect(abs(idle.width - DictationConfig.agentBubbleDiameter) <= 1)
        #expect(abs(running.width - DictationConfig.agentBubbleDiameter * DictationConfig.agentBubbleRunningScale) <= 1)
        // It grows upward: its bottom edge, the one facing the pill, stays put.
        #expect(abs(running.maxY - idle.maxY) <= 1)
        #expect(running.minY < idle.minY)
    }

    /// The bubble's solid circle, in points from the top left: its glow is faint and left out.
    private func drawnCircle(_ bubble: ToolBubble) throws -> CGRect {
        let renderer = ImageRenderer(content: bubble.frame(width: room, height: room))
        renderer.scale = scale
        let bitmap = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
        var box = CGRect.null
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                guard let alpha = bitmap.colorAt(x: x, y: y)?.alphaComponent, alpha > 0.9 else { continue }
                box = box.union(CGRect(x: CGFloat(x) / scale, y: CGFloat(y) / scale, width: 1 / scale, height: 1 / scale))
            }
        }
        return box
    }
}
