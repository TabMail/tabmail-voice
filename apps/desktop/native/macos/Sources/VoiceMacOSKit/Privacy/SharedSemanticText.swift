// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import CVoiceCore
import Foundation

/// Scoped owner of shared semantic reduction. Native code only acquires approved
/// values when requested; it never chooses text limits or counts characters.
final class SharedSemanticText {
    enum Kind: UInt32 { case row = 1, heading = 2, link = 3 }
    enum Decision: UInt32 { case root = 1, descendants = 2, complete = 3, budgetFull = 4 }
    enum Event: UInt32 { case root = 1, descendant = 2, complete = 3, interrupted = 4 }
    struct Run: Codable, Sendable, Equatable {
        var text: String
        var visible: Bool
        init(from decoder: Decoder) throws {
            var values = try decoder.unkeyedContainer()
            text = try values.decode(String.self); visible = try values.decode(Bool.self)
            guard values.isAtEnd else { throw Redactor.Failure.refused }
        }
        func encode(to encoder: Encoder) throws {
            var values = encoder.unkeyedContainer()
            try values.encode(text); try values.encode(visible)
        }
    }
    struct Projection: Codable, Sendable, Equatable { var text: String; var runs: [Run] }
    private let state: OpaquePointer
    private var next: UInt32
    var decision: Decision { get throws {
        guard let value = Decision(rawValue: next) else { throw Redactor.Failure.refused }
        return value
    } }
    init(_ kind: Kind) throws {
        var created: OpaquePointer?
        var next: UInt32 = 0
        guard voice_core_abi_version() == 1,
              voice_core_semantic_new(kind.rawValue, &created, &next) == 0,
              let created else { throw Redactor.Failure.refused }
        self.state = created; self.next = next
    }
    deinit { voice_core_semantic_free(state) }
    func offer(_ event: Event, _ text: String = "") throws {
        let bytes = Array(text.utf8)
        let status = bytes.withUnsafeBufferPointer { buffer in
            voice_core_semantic_offer(state, event.rawValue, buffer.baseAddress, buffer.count, &next)
        }
        guard status == 0 else { throw Redactor.Failure.refused }
    }
    func offerProjected(_ event: Event, _ parts: [String]) throws {
        let bytes = try JSONEncoder().encode(parts)
        let status = bytes.withUnsafeBytes { buffer in
            voice_core_semantic_offer_projected(state, event.rawValue, buffer.bindMemory(to: UInt8.self).baseAddress, buffer.count, &next)
        }
        guard status == 0 else { throw Redactor.Failure.refused }
    }
    func projectedSource() throws -> Projection {
        var output = VoiceCoreBuffer(data: nil, length: 0)
        let status = voice_core_semantic_finish_projected(state, &output)
        defer { voice_core_buffer_free(output) }
        guard status == 0, let data = output.data else { throw Redactor.Failure.refused }
        return try JSONDecoder().decode(Projection.self, from: Data(bytes: data, count: output.length))
    }
    /// Private source: shared screen redaction and presentation limiting must follow.
    func source() throws -> String {
        var output = VoiceCoreBuffer(data: nil, length: 0)
        let status = voice_core_semantic_finish(state, &output)
        defer { voice_core_buffer_free(output) }
        guard status == 0, let data = output.data,
              let text = String(bytes: UnsafeBufferPointer(start: data, count: output.length), encoding: .utf8)
        else { throw Redactor.Failure.refused }
        return text
    }
}
