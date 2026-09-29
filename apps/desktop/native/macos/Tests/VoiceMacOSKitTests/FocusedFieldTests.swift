// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Testing
@testable import VoiceMacOSKit

/// What the correction watch may read of a field: its text, never a password field's, and nothing
/// longer than the cap.
struct FocusedFieldTests {
    @Test func aFieldsTextIsRead() {
        #expect(FocusedField.readable(subrole: nil, value: "Send the Xyvora file", maxLength: 100) == "Send the Xyvora file")
    }

    @Test func aPasswordFieldIsNeverRead() {
        #expect(FocusedField.readable(subrole: kAXSecureTextFieldSubrole, value: "hunter2", maxLength: 100) == nil)
    }

    @Test func aFieldWithoutTextIsNotRead() {
        #expect(FocusedField.readable(subrole: nil, value: nil, maxLength: 100) == nil)
    }

    /// Counted in UTF-16 code units, as the app counts: an emoji is two.
    @Test func textOverTheCapIsNotRead() {
        #expect(FocusedField.readable(subrole: nil, value: "abc", maxLength: 3) == "abc")
        #expect(FocusedField.readable(subrole: nil, value: "abcd", maxLength: 3) == nil)
        #expect(FocusedField.readable(subrole: nil, value: "a😀", maxLength: 3) == "a😀")
        #expect(FocusedField.readable(subrole: nil, value: "ab😀", maxLength: 3) == nil)
    }
}
