// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import CoreGraphics
import Foundation

/// The screen walk's rules, decided by the shared core (`voice_core_walk_json`, ADR-DESK-054): this
/// helper walks the accessibility tree and says what macOS tells it about each element; the core
/// says what to do with it.
enum SharedWalk {
    /// What the OS says about one element. `role` is the shared role (`HelperConfig.contextRoles`).
    struct Node: Encodable {
        var role: String
        var focus: String?
        var part = false
        var inPage = false
        var password = false
        var pageExcluded = false
        var focusedField = false
        var selection = false
        var frame: [Double]?
        var window: [Double]?
        /// Accessibility frames are in points.
        var scale = 1.0
        init(role: String, focus: String? = nil, part: Bool = false, inPage: Bool, frame: CGRect?, window: CGRect?) {
            self.role = role; self.focus = focus; self.part = part; self.inPage = inPage
            self.frame = frame.map(SharedWalk.frame); self.window = window.map(SharedWalk.frame)
        }
    }
    struct Step: Decodable {
        enum Action: String, Decodable { case refuse, skip, caret, descend, text, field, semantic, caption }
        var action: Action
        var kind: String?
        var caretFirst: Bool?
        var childrenInPage: Bool?
        var host: Bool?
        var shown: Bool?
        /// With `skip`: an element that shows nothing, looked inside first as for this read; an
        /// excluded page under it refuses the window.
        var look: Action?
    }
    enum Outcome: String, Decodable { case read, refuse, marker }
    struct Limits: Decodable {
        var nodeBudget: Int
        var focusDepth: Int
    }
    /// One step of a look inside an element for an excluded page. The core's `children` cap is
    /// for providers that fetch children one by one; AX gives them all at once.
    enum CensusStep: Equatable { case notSeenWhole, excluded, protected, skip, descend }

    private static func frame(_ rect: CGRect) -> [Double] {
        [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)]
    }
    private static func call<Reply: Decodable>(_ request: some Encodable, _ reply: Reply.Type) throws -> Reply {
        try JSONDecoder().decode(Reply.self, from: Redactor.request(JSONEncoder().encode(request), operation: .walk))
    }

    /// The walk's budgets. A constant request the core always answers.
    static let limits: Limits = {
        do { return try call(["limits": true], Limits.self) } catch { preconditionFailure("the shared core gives the walk's limits") }
    }()

    static func node(_ facts: Node) throws -> Step { try call(["node": facts], Step.self) }

    /// What a look inside an element read whole (by `read`) found decides its read.
    static func look(_ read: Step.Action, found: ScreenContextReader.PageLook) throws -> Outcome {
        struct Reply: Decodable { var outcome: Outcome }
        let found = switch found { case .none: "none"; case .excluded: "excluded"; case .notSeenWhole: "notSeenWhole" }
        return try call(["look": ["read": read.rawValue, "found": found]], Reply.self).outcome
    }

    private struct CensusReply: Decodable { var step: String }

    /// One step of a look inside an element: `start` for its first, at the element looked inside
    /// (not counted), else after `visited` elements. `page`: nil for an element that is no page,
    /// else whether its site is excluded. `protect`: the look is for text that takes in everything
    /// under the element, which a password element anywhere refuses (`protected`).
    static func census(start: Bool = false, visited: Int = 0, late: Bool, password: Bool = false, page excluded: Bool? = nil,
                       intoPages: Bool = true, protect: Bool = false) throws -> CensusStep {
        struct Request: Encodable {
            var start: Bool?; var visited: Int?; var late: Bool; var password: Bool; var page: String?
            var intoPages: Bool; var protect: Bool
        }
        return try censusStep(call(["census": Request(start: start ? true : nil, visited: start ? nil : visited, late: late,
                                                      password: password, page: excluded.map { $0 ? "excluded" : "allowed" },
                                                      intoPages: intoPages, protect: protect)], CensusReply.self))
    }

    private static func censusStep(_ reply: CensusReply) throws -> CensusStep {
        switch reply.step {
        case "notSeenWhole": return .notSeenWhole
        case "excluded": return .excluded
        case "protected": return .protected
        case "skip": return .skip
        case "descend": return .descend
        default: throw Redactor.Failure.refused
        }
    }

    /// Why the walk stops before its next element, or nil to go on.
    static func stop(nodes: Int, textFull: Bool) throws -> String? {
        struct Request: Encodable { var nodes: Int; var textFull: Bool }
        struct Reply: Decodable { var stopped: String? }
        return try call(["stop": Request(nodes: nodes, textFull: textFull)], Reply.self).stopped
    }
}
