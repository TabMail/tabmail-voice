// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import CVoiceCore
import Foundation

/// Native range transport only. Rust plans, assembles and bounds UTF-16 source.
enum BoundedCaretSource {
    /// `startsParagraph`: whether a paragraph starts at the selection, as the provider lays the
    /// text out; the shared core then puts back a break the text before it leaves out.
    /// `paragraphStarts`: where the provider starts each paragraph near the selection, ascending;
    /// the core puts back the break before each that the text leaves out; `caretEndsLine`: the
    /// selection starts at the end of the line above one starting at its offset.
    static func read(count: Int, selection: NSRange, startsParagraph: Bool? = nil, paragraphStarts: [Int]? = nil,
                     caretEndsLine: Bool = false, range: (NSRange) -> NSString?) throws -> SharedContext.CaretWindow {
        guard count >= 0, selection.location >= 0, selection.length >= 0,
              selection.location <= count, selection.length <= count - selection.location else {
            return SharedContext.CaretWindow(parts: ["", Redactor.placeholder, ""], selectionUnavailable: true)
        }
        let starts = try startsParagraph.map { paragraph in
            try JSONSerialization.data(withJSONObject: ["paragraph": paragraph, "line": false, "lineText": NSNull()])
        }
        let data = try collect(count: count, start: selection.location, end: selection.location + selection.length,
                               purpose: .caret, caretStarts: starts, paragraphStarts: paragraphStarts,
                               caretEndsLine: caretEndsLine, range: range)
        let result = try JSONDecoder().decode(SharedContext.CaretWindow.self, from: data)
        guard result.parts.count == 3 else { throw Redactor.Failure.refused }
        return result
    }
    struct Field: Decodable { let text: String; let complete: Bool }
    static func field(count: Int, interval: NSRange, range: (NSRange) -> NSString?) throws -> Field {
        guard count >= 0, interval.location >= 0, interval.length >= 0,
              interval.location <= count, interval.length <= count - interval.location else { throw Redactor.Failure.refused }
        return try JSONDecoder().decode(Field.self, from: collect(
            count: count, start: interval.location, end: interval.location + interval.length, purpose: .field, range: range))
    }
    /// AX may allocate the complete value before returning it. Subsequent copies
    /// and recognition-edge handling use the same bounded collector as fields.
    static func snapshot(_ text: NSString) throws -> String {
        try JSONDecoder().decode(Field.self, from: collect(count: text.length, start: 0, end: text.length, purpose: .block) { requested in
            text.substring(with: requested) as NSString
        }).text
    }
    struct Projection: Decodable { let parts: [String]; let complete: Bool }
    static func visibleField(count: Int, interval: NSRange, range: (NSRange) -> NSString?) throws -> Projection {
        guard count >= 0, interval.location >= 0, interval.length >= 0,
              interval.location <= count, interval.length <= count - interval.location else { throw Redactor.Failure.refused }
        let result = try JSONDecoder().decode(Projection.self, from: collect(
            count: count, start: interval.location, end: interval.location + interval.length, purpose: .visibleField, range: range))
        guard result.parts.count == 3 else { throw Redactor.Failure.refused }
        return result
    }
    private enum Purpose { case caret, field, visibleField, block }
    private static func collect(count: Int, start: Int, end: Int, purpose: Purpose, caretStarts: Data? = nil,
                                paragraphStarts: [Int]? = nil, caretEndsLine: Bool = false,
                                range: (NSRange) -> NSString?) throws -> Data {
        var owner: OpaquePointer?
        let create = switch purpose {
        case .caret: voice_core_source_utf16_new
        case .field: voice_core_field_utf16_new
        case .block: voice_core_block_utf16_new
        case .visibleField: voice_core_visible_field_utf16_new
        }
        guard voice_core_abi_version() == 1,
              create(count, start, end, &owner) == 0,
              let owner else { throw Redactor.Failure.refused }
        defer { voice_core_source_free(owner) }
        if let caretStarts {
            let status = caretStarts.withUnsafeBytes {
                voice_core_source_caret_starts(owner, $0.bindMemory(to: UInt8.self).baseAddress, $0.count)
            }
            guard status == 0 else { throw Redactor.Failure.refused }
        }
        if let paragraphStarts {
            guard paragraphStarts.allSatisfy({ $0 >= 0 }) else { throw Redactor.Failure.refused }
            let status = paragraphStarts.withUnsafeBufferPointer {
                voice_core_source_paragraph_starts(owner, $0.baseAddress, $0.count, caretEndsLine)
            }
            guard status == 0 else { throw Redactor.Failure.refused }
        }
        while true {
            var start = 0, length = 0
            guard voice_core_source_next(owner, &start, &length) == 0 else { throw Redactor.Failure.refused }
            if length == 0 { break }
            guard start >= 0, start <= count, length <= count - start,
                  let value = range(NSRange(location: start, length: length)), value.length == length else { throw Redactor.Failure.refused }
            var units = [UInt16](repeating: 0, count: length)
            value.getCharacters(&units, range: NSRange(location: 0, length: length))
            let status = units.withUnsafeBufferPointer {
                voice_core_source_utf16_offer(owner, $0.baseAddress, $0.count)
            }
            guard status == 0 else { throw Redactor.Failure.refused }
        }
        var output = VoiceCoreBuffer(data: nil, length: 0)
        let status = voice_core_source_finish(owner, &output)
        defer { voice_core_buffer_free(output) }
        guard status == 0, let bytes = output.data else { throw Redactor.Failure.refused }
        return Data(bytes: bytes, count: output.length)
    }
}
