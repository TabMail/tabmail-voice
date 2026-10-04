// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import CVoiceCore

/// Native values cross the ABI; all matching and redistribution lives in Rust.
enum Redactor {
    static let placeholder = "[redacted]"
    enum Failure: Error { case refused }
    static func redact(_ text: String) throws -> String { try redact([[text]])[0][0] }
    static func redact(_ lines: [[String]]) throws -> [[String]] {
        let data = try request(JSONEncoder().encode(lines))
        let result = try JSONDecoder().decode([[String]].self, from: data)
        guard result.count == lines.count, zip(result, lines).allSatisfy({ $0.count == $1.count }) else { throw Failure.refused }
        return result
    }
    enum Operation { case redact, context, policy, address, viewport }
    static func request(_ input: Data, operation: Operation = .redact) throws -> Data {
        guard voice_core_abi_version() == 1 else { throw Failure.refused }
        var output = VoiceCoreBuffer(data: nil, length: 0)
        let status = input.withUnsafeBytes { bytes in
            (operation == .viewport ? voice_core_viewport_json : operation == .address ? voice_core_address_json : operation == .context ? voice_core_context_json : operation == .policy ? voice_core_policy_json : voice_core_redact_json)(bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count, &output)
        }
        defer { voice_core_buffer_free(output) }
        guard status == 0, let data = output.data else { throw Failure.refused }
        return Data(bytes: data, count: output.length)
    }

}

extension ScreenContext {
    var redacted: ScreenContext {
        get throws {
            guard !coreFailed else { throw Redactor.Failure.refused }
            var context = self
            context.windowTitle = try windowTitle.map(Redactor.redact)
            if terminalViewport != nil { return context }
            let result = try SharedContext.process(blocks: blocks, caret: [textBeforeCaret, selectedText, textAfterCaret])
            guard let caret = result.caret, caret.count == 3 else { throw Redactor.Failure.refused }
            context.blocks = try result.nativeBlocks()
            if result.truncated && context.stoppedEarly == nil { context.stoppedEarly = "text budget" }
            context.textBeforeCaret = caret[0]
            context.selectedText = caret[1]
            context.textAfterCaret = caret[2]
            return context
        }
    }
}
