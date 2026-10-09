// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// Request rules every helper shares, decided by the shared core (`voice_core_request_json`,
/// ADR-DESK-054): a focused field read's bound and reply, a paste's text, and the clipboard a paste
/// saves and puts back.
enum SharedRequest {
    private static func call(_ request: JSON) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: Redactor.request(JSONEncoder().encode(request), operation: .request))
    }

    /// The bound a `focusedFieldValue` request asks for, in UTF-16 code units: 1 to 20,000.
    static func fieldBound(_ value: JSON?) throws -> Int {
        guard let bound = (try? call(["field": ["maxLength": value ?? .null]]))?["maxLength"]?.integer else {
            throw HelperError("focusedFieldValue needs a maxLength the shared core accepts")
        }
        return bound
    }

    /// `focusedFieldValue`'s reply for the field as read: null for none or one longer than
    /// `maxLength`, else the text with secret-looking text taken out; for a terminal, the box around
    /// its cursor the core cuts from its viewport, null without one.
    static func fieldValue(_ read: FocusedField.Read?, maxLength: Int) throws -> JSON {
        let bound = JSON.number(Double(maxLength))
        switch read {
        case .terminal(let viewport):
            let reply = try call(["field": ["maxLength": bound, "viewport": viewport]])
            if reply["value"] == .null {
                HelperLog.debug("FocusedField: the terminal gave no box around its cursor within \(maxLength) code units")
            }
            return reply
        case .text(let text):
            let reply = try call(["field": ["maxLength": bound, "text": .string(text)]])
            if reply["value"] == .null {
                HelperLog.debug("FocusedField: \(text.utf16.count) code units, over \(maxLength)")
            }
            return reply
        case nil:
            return try call(["field": ["maxLength": bound, "text": .null]])
        }
    }

    /// How long after a paste's keys the clipboard as it was goes back, and the most a saved
    /// clipboard may hold (`ClipboardKeeper`).
    struct ClipboardRules: Decodable, Sendable {
        /// Milliseconds.
        var restoreDelay: Int
        var maxBytes: Int
        var maxFormats: Int
    }

    static let clipboardRules: ClipboardRules = {
        do {
            let reply = try call(["clipboard": [:]])
            return try JSONDecoder().decode(ClipboardRules.self, from: JSONEncoder().encode(reply))
        } catch {
            preconditionFailure("the shared core gives the clipboard's rules")
        }
    }()

    /// Refuses a paste's text that is empty, longer than the core allows or holds a NUL.
    static func insert(_ text: String) throws {
        guard (try? call(["insert": ["text": .string(text)]])) != nil else { throw HelperError("insert needs text to paste") }
    }
}
