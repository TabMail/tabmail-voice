// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// A request whose number is no whole number in range (a fraction, 1e100) is refused with an
/// error, not converted: a trapping conversion would crash the helper, and with it the dictation.
@MainActor
struct MacServiceRequestTests {
    @Test func aMalformedNumberIsRefusedNotTrappedOn() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(on: channel)
        let requests = [
            #"{"id":3,"method":"caretAnchor","params":{"pid":1e100}}"#,
            #"{"id":4,"method":"globeUpdate","params":{"value":1e100}}"#,
            #"{"id":5,"method":"insert","params":{"text":"x","restoreDelay":1e300}}"#,
            #"{"id":6,"method":"focusedFieldValue","params":{"pid":1e100,"maxLength":10}}"#,
            #"{"id":7,"method":"focusedFieldValue","params":{"pid":1,"maxLength":-1}}"#,
            #"{"id":8,"method":"focusedFieldValue","params":{"pid":1}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
        withExtendedLifetime(service) {}
    }
}
