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
        #expect(cases.count >= 150)
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

        let reply = context.json

        #expect(reply["windowTitle"]?.string == "deploy \(gone)")
        #expect(reply["textBeforeCaret"]?.string == "key \(gone)")
        #expect(reply["selectedText"]?.string == gone)
        #expect(reply["textAfterCaret"]?.string == "\(gone) end")
        #expect(reply["renderedText"]?.string == "## Keys \(gone)\n| name | \(gone)\n> export KEY=\(gone)\n» key \(gone)‸\(gone)‸\(gone) end")
        #expect(reply["logDescription"]?.string?.contains(secret) == false)
        #expect(reply["logDescription"]?.string?.contains("--- text before the caret ---\nkey \(gone)\n") == true)
        // What isn't text read off the screen is left as read.
        #expect(reply["appName"]?.string == "Example Terminal")
        #expect(reply["bundleID"]?.string == "org.example.terminal")
        #expect(reply["host"]?.string == "example.com")
        #expect(reply["terminalProgram"]?.string == "zsh")
        #expect(reply["focusedRole"]?.string == "AXTextArea")
        #expect(reply["summary"]?.string?.contains(secret) == false)
    }

    /// What leaves the helper (`json`) has the visible text redacted joined as well: a secret spread
    /// over several elements, one line or one word each, only shows once they are joined.
    @Test func aSecretSpreadOverSeveralElementsIsRedactedInWhatLeavesTheHelper() {
        let body = ["a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0", "u1V2w3X4y5Z6a7B8c9D0e1F2g3H4i5J6k7L8m9N0"]
        let token = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"
        var context = ScreenContext(appName: "Example Browser")
        context.append(.text, "Your key:")
        context.append(.text, "-----BEGIN " + "PRIVATE KEY-----")
        context.append(.text, body[0])
        context.append(.text, body[1])
        context.append(.text, "-----END " + "PRIVATE KEY-----")
        context.append(.text, "Authorization: Bearer")
        context.append(.text, token)
        context.append(.text, "Done")

        let reply = context.json
        let gone = Redactor.placeholder
        #expect(reply["renderedText"]?.string == "Your key:\n\(gone)\nAuthorization: Bearer\n\(gone)\nDone")
        let log = reply["logDescription"]?.string ?? ""
        #expect(log.hasSuffix("--- visible text ---\nYour key:\n\(gone)\nAuthorization: Bearer\n\(gone)\nDone"))
        for secret in body + [token] { #expect(!log.contains(secret)) }
    }

    /// The reply says when the selection had secret-looking text taken out, so the app never pastes a
    /// rewrite of the redacted selection over the user's own text.
    @Test func theReplySaysWhenTheSelectionWasRedacted() {
        var context = ScreenContext(appName: "Example Editor")
        context.textBeforeCaret = "url = "
        context.selectedText = "postgres://app:" + "hunter2" + "@db.example.com/prod"
        let redacted = context.json
        #expect(redacted["selectedText"]?.string == "postgres://app:\(Redactor.placeholder)@db.example.com/prod")
        #expect(redacted["selectionRedacted"] == .bool(true))

        // A secret elsewhere on the screen is not one in the selection.
        context.selectedText = "the connection string"
        context.textBeforeCaret = "token=" + "abc123def456 "
        let plain = context.json
        #expect(plain["selectedText"]?.string == "the connection string")
        #expect(plain["textBeforeCaret"]?.string == "token=\(Redactor.placeholder) ")
        #expect(plain["selectionRedacted"] == .bool(false))

        #expect(ScreenContext(appName: "Example Editor").json["selectionRedacted"] == .bool(false))
    }

    /// Text read off the screen has no length limit and may be anyone's, and it is redacted with no
    /// deadline: each pattern must take time in proportion to the text. A pattern scanned again from
    /// every position took minutes on these.
    /// One text after another, so that the suites running beside this one keep their cores.
    @Test func hostileTextIsRedactedInTimeProportionalToItsLength() {
        let length = 200_000
        let clock = ContinuousClock()
        for unit in ["a.", "token:", "-eyJ", "-----BEGIN A ", "://a:b", "Bearer ", "-sk-a", "password" + String(repeating: " ", count: 64), "a"] {
            let text = String(repeating: unit, count: length / unit.count + 1)
            let elapsed = clock.measure { _ = Redactor.redact(text) }
            #expect(elapsed < .seconds(5), "\(unit.prefix(16)): \(elapsed)")
        }
    }
}
