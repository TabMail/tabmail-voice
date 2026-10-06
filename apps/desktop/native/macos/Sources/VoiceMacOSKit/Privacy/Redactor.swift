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
    enum Operation { case redact, context, policy, text, address, viewport, screen }
    static func request(_ input: Data, operation: Operation = .redact) throws -> Data {
        guard voice_core_abi_version() == 1 else { throw Failure.refused }
        let call = switch operation {
        case .redact: voice_core_redact_json
        case .context: voice_core_context_json
        case .policy: voice_core_policy_json
        case .text: voice_core_redact_text_json
        case .address: voice_core_address_json
        case .viewport: voice_core_viewport_json
        case .screen: voice_core_screen_json
        }
        var output = VoiceCoreBuffer(data: nil, length: 0)
        let status = input.withUnsafeBytes { bytes in
            call(bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count, &output)
        }
        defer { voice_core_buffer_free(output) }
        guard status == 0, let data = output.data else { throw Failure.refused }
        return Data(bytes: data, count: output.length)
    }

}
