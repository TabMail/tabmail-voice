// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Testing
import VoiceHelperSupport
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

    /// A terminal's text is its whole scrollback: its field is read by its viewport, whose box around
    /// the cursor the shared core cuts out, and never by its text, even when the viewport can't be read.
    @Test(arguments: Array(HelperConfig.terminalBundleIDs))
    func aTerminalIsReadByItsViewportOnly(bundleID: String) {
        let viewport: JSON = ["surfaces": []]
        #expect(FocusedField.read(bundleID: bundleID, text: { Issue.record("text read"); return "scrollback" }, viewport: { viewport }) == .terminal(viewport))
        #expect(FocusedField.read(bundleID: bundleID, text: { Issue.record("text read"); return "scrollback" }, viewport: { nil }) == nil)
    }

    @Test(arguments: ["com.apple.TextEdit", nil] as [String?])
    func anotherAppIsReadByItsText(bundleID: String?) {
        #expect(FocusedField.read(bundleID: bundleID, text: { "Send the Xyvora file" }, viewport: { Issue.record("viewport read"); return nil }) == .text("Send the Xyvora file"))
    }
}
