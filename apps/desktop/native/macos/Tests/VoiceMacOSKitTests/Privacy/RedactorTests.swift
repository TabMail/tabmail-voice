// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import VoiceMacOSKit

/// What looks like a secret is taken out of text read off the screen, and everything around it, and
/// everything that only resembles one, stays (ADR-DESK-046). The cases are the ones every platform's
/// helper must pass: `native/shared/privacy/redaction-cases.json`.
struct RedactorTests {
    private struct Cases: Decodable {
        struct Case: Decodable {
            var name: String
            var text: [String]
            var expected: [String]
        }
        var cases: [Case]
    }

    /// The shared cases, with `{redacted}` standing for the placeholder.
    private static func sharedCases() throws -> [(name: String, text: String, expected: String)] {
        let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: native.appendingPathComponent("shared/privacy/redaction-cases.json"))
        func joined(_ fragments: [String]) -> String { fragments.map { $0 == "{redacted}" ? Redactor.placeholder : $0 }.joined() }
        return try JSONDecoder().decode(Cases.self, from: data).cases.map { ($0.name, joined($0.text), joined($0.expected)) }
    }

    @Test func everySharedCaseIsRedactedAsExpected() throws {
        let cases = try Self.sharedCases()
        #expect(cases.count >= 60)
        #expect(cases.contains { $0.text != $0.expected })
        #expect(cases.contains { $0.text == $0.expected && !$0.text.isEmpty })
        for (name, text, expected) in cases {
            #expect(Redactor.redact(text) == expected, "\(name)")
        }
    }

    /// Redacting what is already redacted changes nothing.
    @Test func redactingTwiceIsRedactingOnce() throws {
        for (name, text, _) in try Self.sharedCases() {
            let once = Redactor.redact(text)
            #expect(Redactor.redact(once) == once, "\(name)")
        }
    }

    /// Every text of the screen read is redacted, and what isn't screen text is left as read.
    @Test func everyTextOfTheScreenReadIsRedacted() {
        let secret = "sk" + "-" + "a1B2c3D4e5F6g7H8i9J0k1L2"
        let gone = Redactor.placeholder
        var context = ScreenContext(appName: "Example Terminal", bundleID: "org.example.terminal")
        context.windowTitle = "deploy \(secret)"
        context.host = "example.com"
        context.terminalProgram = "zsh"
        context.focusedRole = "AXTextArea"
        context.textBeforeCaret = "key \(secret)"
        context.selectedText = secret
        context.textAfterCaret = "\(secret) end"
        context.append(.heading, "Keys \(secret)")
        context.append(.row, "name | \(secret)")
        context.append(.field, "export KEY=\(secret)")
        context.appendCaret()
        context.nodesVisited = 4

        let redacted = context.redacted

        var expected = ScreenContext(appName: "Example Terminal", bundleID: "org.example.terminal")
        expected.windowTitle = "deploy \(gone)"
        expected.host = "example.com"
        expected.terminalProgram = "zsh"
        expected.focusedRole = "AXTextArea"
        expected.textBeforeCaret = "key \(gone)"
        expected.selectedText = gone
        expected.textAfterCaret = "\(gone) end"
        expected.append(.heading, "Keys \(gone)")
        expected.append(.row, "name | \(gone)")
        expected.append(.field, "export KEY=\(gone)")
        expected.appendCaret()
        expected.nodesVisited = 4
        #expect(redacted == expected)
        #expect(!redacted.renderedText().contains(secret))
        #expect(!redacted.logDescription.contains(secret))
        #expect(redacted.renderedText().contains(gone))
    }
}
