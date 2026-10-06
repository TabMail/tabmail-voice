// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Testing
@testable import VoiceMacOSKit

/// What the correction watch may read of a field: its text, never a password field's. How long it
/// may be is the shared core's (`request-cases.json`).
struct FocusedFieldTests {
    @Test func aFieldsTextIsRead() {
        #expect(FocusedField.readable(subrole: nil, value: "Send the Xyvora file") == "Send the Xyvora file")
    }

    @Test func aPasswordFieldIsNeverRead() {
        #expect(FocusedField.readable(subrole: kAXSecureTextFieldSubrole, value: "hunter2") == nil)
    }

    @Test func aFieldWithoutTextIsNotRead() {
        #expect(FocusedField.readable(subrole: nil, value: nil) == nil)
    }
}
