// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport

/// Request rules every helper shares, decided by the shared core (`voice_core_request_json`,
/// ADR-DESK-054): a focused field read's bound and reply, and a paste's text.
enum SharedRequest {
    private static func call(_ request: JSON) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: Redactor.request(JSONEncoder().encode(request), operation: .request))
    }

    /// The bound a `focusedFieldValue` request asks for, in UTF-16 code units: 1 to 20,000.
    static func fieldBound(_ value: JSON?) throws -> Int {
        guard let bound = (try? call(["field": ["maxLength": value ?? .null]]))?["maxLength"]?.integer else {
            throw HelperError("focusedFieldValue needs maxLength from 1 to 20000")
        }
        return bound
    }

    /// `focusedFieldValue`'s reply for the field's text as read: null for none or one longer than
    /// `maxLength`, else the text with secret-looking text taken out.
    static func fieldValue(_ text: String?, maxLength: Int) throws -> JSON {
        try call(["field": ["maxLength": .number(Double(maxLength)), "text": text.map(JSON.string) ?? .null]])
    }

    /// Refuses a paste's text that is empty, longer than the core allows or holds a NUL.
    static func insert(_ text: String) throws {
        guard (try? call(["insert": ["text": .string(text)]])) != nil else { throw HelperError("insert needs text to paste") }
    }
}
