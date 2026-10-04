// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import VoiceHotkeyKit

struct GestureTraceTests {
    struct Trace: Decodable {
        struct Step: Decodable {
            let event: String
            let time: Double
            let action: String?
            let holding: Bool
            let handsFree: Bool
            let space: Bool
            let escape: Bool
            let agent: Bool?
            let key: UInt16?
            let `repeat`: Bool?
            let chat: Bool?
        }
        let name: String
        let tapMaxDuration: Double
        let doubleTapWindow: Double
        let steps: [Step]
    }

    @Test func sharedTransitionTraces() throws {
        let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let traces = try JSONDecoder().decode([Trace].self, from: Data(contentsOf: native.appendingPathComponent("shared/hotkey/gesture-cases.json")))
        #expect(traces.count == 7)
        for trace in traces {
            var gesture = PushToTalkGesture(hotkey: .rightOption, tapMaxDuration: trace.tapMaxDuration, doubleTapWindow: trace.doubleTapWindow)
            for step in trace.steps {
                var action: PushToTalkGesture.Action?
                switch step.event {
                case "down", "up":
                    action = gesture.modifierChanged(keyCode: gesture.hotkey.keyCode, isDown: step.event == "down", at: step.time, agent: step.agent ?? false)
                case "key":
                    let key = step.key == 32 ? PushToTalkGesture.toggleKeyCode : step.key == 27 ? PushToTalkGesture.cancelKeyCode : UInt16(0)
                    action = gesture.keyPressed(keyCode: key, isRepeat: step.repeat ?? false)
                case "chat":
                    guard let chat = step.chat else { Issue.record("Missing chat state"); return }
                    gesture.isChatOpen = chat
                case "ended": gesture.dictationEnded()
                default: Issue.record("Unknown trace event"); return
                }
                #expect(action?.rawValue == step.action, "\(trace.name)")
                #expect(gesture.isHolding == step.holding && gesture.isHandsFree == step.handsFree, "\(trace.name)")
                #expect(gesture.owns(keyCode: PushToTalkGesture.toggleKeyCode) == step.space, "\(trace.name)")
                #expect(gesture.owns(keyCode: PushToTalkGesture.cancelKeyCode) == step.escape, "\(trace.name)")
            }
        }
    }
}
