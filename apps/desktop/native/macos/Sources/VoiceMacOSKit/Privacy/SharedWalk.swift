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
        var thin = Double(HelperConfig.contextHiddenMaxThickness)
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
    }
    enum Outcome: String, Decodable { case read, refuse, marker }
    struct Limits: Decodable {
        var nodeBudget: Int
        var timeBudgetMilliseconds: Int
        var focusDepth: Int
    }
    /// One step of a look inside an element for an excluded page.
    enum CensusStep: Equatable { case notSeenWhole, excluded, skip, descend(children: Int) }

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

    private struct CensusReply: Decodable { var step: String; var children: Int? }

    /// The look's first step, at the element looked inside: how many of its children to fetch.
    static func censusStart(late: Bool) throws -> CensusStep {
        try censusStep(call(["census": ["start": true, "late": late]], CensusReply.self))
    }

    /// `page`: nil for an element that is no page, else whether its site is excluded.
    static func census(visited: Int, queued: Int, late: Bool, page excluded: Bool?, intoPages: Bool) throws -> CensusStep {
        struct Request: Encodable { var visited: Int; var queued: Int; var late: Bool; var page: String?; var intoPages: Bool }
        return try censusStep(call(["census": Request(visited: visited, queued: queued, late: late,
                                               page: excluded.map { $0 ? "excluded" : "allowed" }, intoPages: intoPages)], CensusReply.self))
    }

    private static func censusStep(_ reply: CensusReply) throws -> CensusStep {
        switch (reply.step, reply.children) {
        case ("notSeenWhole", _): return .notSeenWhole
        case ("excluded", _): return .excluded
        case ("skip", _): return .skip
        case ("descend", let children?): return .descend(children: children)
        default: throw Redactor.Failure.refused
        }
    }

    /// Why the walk stops before its next element, or nil to go on.
    static func stop(nodes: Int, since started: Date, textFull: Bool) throws -> String? {
        struct Request: Encodable { var nodes: Int; var elapsed: Int; var textFull: Bool }
        struct Reply: Decodable { var stopped: String? }
        let elapsed = Int(max(0, Date().timeIntervalSince(started)) * 1000)
        return try call(["stop": Request(nodes: nodes, elapsed: elapsed, textFull: textFull)], Reply.self).stopped
    }
}
