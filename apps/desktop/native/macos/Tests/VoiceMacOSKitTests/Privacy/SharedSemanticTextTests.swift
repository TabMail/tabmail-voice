// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation
import Testing
@testable import VoiceMacOSKit

struct SharedSemanticTextTests {
    @Test func projectedTransportPreservesCaretAndStripsPrivateMetadata() throws {
        let reducer = try SharedSemanticText(.row)
        try reducer.offerProjected(.descendant, ["password: ", "syntheticSecret123", ""])
        try reducer.offer(.complete)
        #expect(throws: (any Error).self) { try reducer.source() }
        var context = ScreenContext(appName: "Synthetic")
        context.textBeforeCaret = "Draft "
        context.appendCaret()
        context.appendSemantic(.row, try reducer.projectedSource())
        context.appendSemantic(.row, try reducer.projectedSource())
        #expect(context.blocks.count == 2)
        #expect(try context.renderedText() == "» Draft ‸\n| [redacted]")
        let finalized = try SharedContext.process(blocks: context.blocks, caret: ["Draft ", "", ""])
        #expect(try finalized.nativeBlocks().allSatisfy { $0.runs == nil && $0.source == nil })
    }

    @Test func commonCorpusUsesTheSameAcquisitionDecisionsOnEveryPlatform() throws {
        struct Fragment: Decodable { let text: String; let `repeat`: Int; var expanded: String { String(repeating: text, count: `repeat`) } }
        struct Event: Decodable { let event: UInt32; let text: String; let `repeat`: Int; let decision: UInt32 }
        struct Item: Decodable { let name: String; let kind: UInt32; let initial: UInt32; let events: [Event]; let expected: Fragment }
        struct Corpus: Decodable { let cases: [Item] }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../shared/context/semantic-cases.json").standardizedFileURL
        let cases = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: file)).cases
        #expect(cases.count >= 11)
        for item in cases {
            let text = try SharedSemanticText(#require(SharedSemanticText.Kind(rawValue: item.kind)))
            #expect(try text.decision.rawValue == item.initial)
            for event in item.events {
                try text.offer(#require(SharedSemanticText.Event(rawValue: event.event)), String(repeating: event.text, count: event.repeat))
                #expect(try text.decision.rawValue == event.decision, "\(item.name)")
            }
            #expect(try text.source() == item.expected.expanded, "\(item.name)")
        }
    }
}
