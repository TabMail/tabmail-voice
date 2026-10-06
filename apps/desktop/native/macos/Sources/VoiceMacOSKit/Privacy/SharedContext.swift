// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Foundation

enum SharedContext {
    struct Block: Encodable {
        var kind: String
        var text: String
        var frame: [Double]?
        var source: [String]?
        var runs: [SharedSemanticText.Run]?
        init(_ block: ScreenContext.Block) {
            kind = block.kind.rawValue; text = block.text; source = block.source; runs = block.runs
            frame = block.frame.map { [Double($0.minX), Double($0.minY), Double($0.width), Double($0.height)] }
        }
    }
    struct Admission: Decodable { var text: String; var used: Int; var budgetFull: Bool }
    /// Private recognition source; combined redaction must run before use.
    struct SourceLimits: Decodable {
        var sourceWindowBytes: Int
        var selectionSourceBytes: Int
        var sourceChunkUnits: Int
    }
    static func sourceLimits() throws -> SourceLimits {
        let input = try JSONSerialization.data(withJSONObject: ["limits": true])
        return try JSONDecoder().decode(SourceLimits.self, from: Redactor.request(input, operation: .context))
    }
    struct CaretWindow: Decodable {
        var parts: [String]
        var selectionUnavailable: Bool
    }
    static func caretWindow(_ parts: [String], startKnown: Bool, endKnown: Bool) throws -> CaretWindow {
        let input = try JSONSerialization.data(withJSONObject: ["caretWindow": [
            "parts": parts, "startKnown": startKnown, "endKnown": endKnown,
        ]])
        let result = try JSONDecoder().decode(CaretWindow.self, from: Redactor.request(input, operation: .context))
        guard result.parts.count == 3 else { throw Redactor.Failure.refused }
        return result
    }
    struct Reservation: Decodable { var used: Int; var budgetFull: Bool }
    static func reserveCaret(_ parts: [String]) throws -> Reservation {
        let input = try JSONSerialization.data(withJSONObject: ["reserveCaret": parts])
        return try JSONDecoder().decode(Reservation.self, from: Redactor.request(input, operation: .context))
    }
    static func admit(_ text: String, previous: String?, used: Int) throws -> Admission {
        var request: [String: Any] = ["admit": text, "used": used]
        if let previous { request["previous"] = previous }
        let input = try JSONSerialization.data(withJSONObject: request)
        return try JSONDecoder().decode(Admission.self, from: Redactor.request(input, operation: .context))
    }
    struct FieldPlan: Decodable { var probeWhole: Bool; var useWhole: Bool }
    static func fieldPlan(count: Int?, text: String? = nil) throws -> FieldPlan {
        var value: [String: Any] = [:]
        if let count { value["count"] = count }
        if let text { value["text"] = text }
        let input = try JSONSerialization.data(withJSONObject: ["fieldPlan": value])
        return try JSONDecoder().decode(FieldPlan.self, from: Redactor.request(input, operation: .context))
    }
    struct SemanticAdmission: Decodable { var text: String; var runs: [SharedSemanticText.Run]; var used: Int; var budgetFull: Bool }
    static func admitSemantic(_ source: SharedSemanticText.Projection, kind: ScreenContext.Block.Kind, used: Int, previous: ScreenContext.Block?) throws -> SemanticAdmission {
        struct Value: Encodable { var kind: String; var text: String; var runs: [SharedSemanticText.Run] }
        struct Request: Encodable { var admitSemantic: Value; var used: Int; var previous: Block? }
        let input = try JSONEncoder().encode(Request(admitSemantic: Value(kind: kind.rawValue, text: source.text, runs: source.runs), used: used, previous: previous.map(Block.init)))
        return try JSONDecoder().decode(SemanticAdmission.self, from: Redactor.request(input, operation: .context))
    }
    struct FieldAdmission: Decodable { var parts: [String]; var used: Int; var budgetFull: Bool }
    static func admitField(_ parts: [String], used: Int) throws -> FieldAdmission {
        let input = try JSONSerialization.data(withJSONObject: ["admitField": parts, "used": used])
        let result = try JSONDecoder().decode(FieldAdmission.self, from: Redactor.request(input, operation: .context))
        guard result.parts.count == 3 else { throw Redactor.Failure.refused }
        return result
    }
    static func normalize(_ text: String, previous: String?) throws -> String {
        var request = ["normalize": text]
        if let previous { request["previous"] = previous }
        let input = try JSONSerialization.data(withJSONObject: request)
        let response = try JSONSerialization.jsonObject(with: Redactor.request(input, operation: .context)) as? [String: Any]
        guard let result = response?["text"] as? String else { throw Redactor.Failure.refused }
        return result
    }
}
