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
        /// Several texts redacted together: each line's texts, in fragments as a case's text is.
        struct LineCase: Decodable {
            var name: String
            var lines: [[[String]]]
            var expected: [[[String]]]
        }
        var cases: [Case]
        var lineCases: [LineCase]
    }

    private static func sharedFile() throws -> Cases {
        let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode(Cases.self, from: Data(contentsOf: native.appendingPathComponent("shared/privacy/redaction-cases.json")))
    }

    private static func joined(_ fragments: [String]) -> String { fragments.map { $0 == "{redacted}" ? Redactor.placeholder : $0 }.joined() }

    /// The shared cases, with `{redacted}` standing for the placeholder.
    private static func sharedCases() throws -> [(name: String, text: String, expected: String)] {
        try sharedFile().cases.map { ($0.name, joined($0.text), joined($0.expected)) }
    }

    @Test func everySharedCaseIsRedactedAsExpected() throws {
        let cases = try Self.sharedCases()
        #expect(cases.count >= 270)
        #expect(cases.contains { $0.text != $0.expected })
        #expect(cases.contains { $0.text == $0.expected && !$0.text.isEmpty })
        for (name, text, expected) in cases {
            #expect(Redactor.redact(text) == expected, "\(name)")
        }
    }

    /// Several texts redacted together, each keeping its share: the shared cases every helper passes.
    @Test func everySharedCaseOfSeveralTextsIsRedactedAsExpected() throws {
        let cases = try Self.sharedFile().lineCases
        #expect(cases.count >= 15)
        for item in cases {
            #expect(Redactor.redact(item.lines.map { $0.map(Self.joined) }) == item.expected.map { $0.map(Self.joined) }, "\(item.name)")
        }
    }

    /// What a replacement keeps of its match's start and end never overlaps, so a text's share never
    /// ends before it starts.
    @Test func whatAReplacementKeepsOfItsMatchDoesNotOverlap() {
        #expect(Redactor.kept(of: "aa", in: "a") == (1, 0))
        #expect(Redactor.kept(of: "a", in: "aa") == (1, 0))
        #expect(Redactor.kept(of: "://u:secret@", in: "://u:[redacted]@") == (5, 1))
        #expect(Redactor.kept(of: "secret", in: "[redacted]") == (0, 0))
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
        context.textBeforeCaret = "key \(secret) "
        context.selectedText = secret
        context.textAfterCaret = " \(secret) end"
        context.append(.heading, "Keys \(secret)")
        context.append(.row, "name | \(secret)")
        context.append(.field, "export KEY=\(secret)")
        context.appendCaret()
        context.nodesVisited = 4

        let reply = context.json

        #expect(reply["windowTitle"]?.string == "deploy \(gone)")
        #expect(reply["textBeforeCaret"]?.string == "key \(gone) ")
        #expect(reply["selectedText"]?.string == gone)
        #expect(reply["textAfterCaret"]?.string == " \(gone) end")
        #expect(reply["renderedText"]?.string == "## Keys \(gone)\n| name | \(gone)\n> export KEY=\(gone)\n» key \(gone) ‸\(gone)‸ \(gone) end")
        #expect(reply["logDescription"]?.string?.contains(secret) == false)
        #expect(reply["logDescription"]?.string?.contains("--- text before the caret ---\nkey \(gone) \n") == true)
        // What isn't text read off the screen is left as read.
        #expect(reply["appName"]?.string == "Example Terminal")
        #expect(reply["bundleID"]?.string == "org.example.terminal")
        #expect(reply["host"]?.string == "example.com")
        #expect(reply["terminalProgram"]?.string == "zsh")
        #expect(reply["focusedRole"]?.string == "AXTextArea")
        #expect(reply["summary"]?.string?.contains(secret) == false)
    }

    /// The visible text is redacted as the one text its elements make: a secret spread over several
    /// elements, one line or one word each, only shows once they are joined.
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
        // The blocks left empty are gone, the others are where they were.
        #expect(context.redacted.blocks.map(\.text) == ["Your key:", gone, "Authorization: Bearer", gone, "Done"])
    }

    /// A secret of several lines is redacted whatever kind of element shows it: the marks the
    /// rendering puts before a field's, a row's and the focused field's lines are no part of it.
    @Test func aSecretOfSeveralLinesIsRedactedInAFieldInRowsAndInTheFocusedField() {
        let begin = "-----BEGIN " + "PRIVATE KEY-----", end = "-----END " + "PRIVATE KEY-----"
        let body = ["a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0", "u1V2w3X4y5Z6a7B8c9D0e1F2g3H4i5J6k7L8m9N0"]
        let token = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"
        let key = ([begin] + body + [end]).joined(separator: "\n")
        let gone = Redactor.placeholder
        var context = ScreenContext(appName: "Example Editor")
        context.append(.field, "first\n\(key)\nlast")
        context.append(.field, "Authorization: Bearer\n\(token)\nsent")
        for line in ["id_example"] + [begin] + body + [end] + ["id_other"] { context.append(.row, line) }
        context.textBeforeCaret = "mine\n\(key)\nthen "
        context.textAfterCaret = "after"
        context.appendCaret()

        let reply = context.json
        #expect(reply["renderedText"]?.string == """
        > first
        > \(gone)
        > last
        > Authorization: Bearer
        > \(gone)
        > sent
        | id_example
        | \(gone)
        | id_other
        » mine
        » \(gone)
        » then ‸after
        """)
        #expect(reply["textBeforeCaret"]?.string == "mine\n\(gone)\nthen ")
        #expect(reply["textAfterCaret"]?.string == "after")
        let log = reply["logDescription"]?.string ?? ""
        for secret in body + [token] { #expect(!log.contains(secret)) }
    }

    /// A secret the caret is inside, or the selection is part of, is found: the focused field's texts
    /// are redacted as the one text they are, and its block is made of them again.
    @Test func aSecretTheCaretOrTheSelectionIsInsideIsRedacted() {
        let gone = Redactor.placeholder
        var context = ScreenContext(appName: "Example Terminal")
        context.textBeforeCaret = "export KEY=" + "sk" + "-" + "a1B2c3"
        context.textAfterCaret = "D4e5F6g7H8i9J0k1L2 next"
        context.append(.text, "Shell")
        context.appendCaret()
        context.append(.text, "Below")

        var reply = context.json
        #expect(reply["textBeforeCaret"]?.string == "export KEY=\(gone)")
        #expect(reply["selectedText"]?.string == "")
        #expect(reply["textAfterCaret"]?.string == " next")
        #expect(reply["renderedText"]?.string == "Shell\n» export KEY=\(gone)‸ next\nBelow")
        #expect(reply["selectionRedacted"] == .bool(false))
        #expect(reply["logDescription"]?.string?.contains("a1B2c3") == false)
        #expect(reply["logDescription"]?.string?.contains("D4e5F6") == false)

        // A selection wholly inside the secret is still a selection, and one the app must not rewrite.
        context = ScreenContext(appName: "Example Terminal")
        context.textBeforeCaret = "sk" + "-" + "a1B2"
        context.selectedText = "c3D4e5F6"
        context.textAfterCaret = "g7H8i9J0k1L2"
        context.appendCaret()
        reply = context.json
        #expect(reply["textBeforeCaret"]?.string == gone)
        #expect(reply["selectedText"]?.string == gone)
        #expect(reply["textAfterCaret"]?.string == "")
        #expect(reply["renderedText"]?.string == "» \(gone)‸\(gone)‸")
        #expect(reply["selectionRedacted"] == .bool(true))
    }

    /// A run far longer than any real text never stops a redactor short: what follows it is still
    /// redacted. (The engine gives up on a repeat it runs a stack frame for per character, and
    /// giving up is fast and silent.)
    @Test func aVeryLongRunDoesNotStopTheRedactionOfWhatFollows() {
        let length = 400_000
        let runs = [
            "sk" + "-" + String(repeating: "a", count: length),
            "data token=7" + String(repeating: "a", count: length),
            "Bearer " + String(repeating: "a", count: length),
            "password:" + String(repeating: " ", count: length) + "x",
            "Bearer" + String(repeating: " ", count: length) + "x",
        ]
        for run in runs {
            let redacted = Redactor.redact("\(run)\npassword: hunter" + "2x\n")
            #expect(redacted.hasSuffix("\npassword: \(Redactor.placeholder)\n"), "\(run.prefix(16))")
            var context = ScreenContext(appName: "Example Browser")
            context.append(.text, run)
            context.append(.text, "password: hunter" + "2x")
            context.textBeforeCaret = "pwd=hunter" + "3y "
            context.selectedText = "token=abc" + "123def"
            let reply = context.json
            #expect(reply["renderedText"]?.string?.contains("hunter") == false, "\(run.prefix(16))")
            #expect(reply["textBeforeCaret"]?.string == "pwd=\(Redactor.placeholder) ")
            #expect(reply["selectionRedacted"] == .bool(true))
        }
    }

    /// A redactor the engine could not finish withholds everything after its last match: nothing it
    /// did not look at is sent.
    @Test func aRedactorThatCouldNotFinishWithholdsTheRest() {
        // One stack frame per character: the engine gives up on a long enough run.
        let greedy = Redactor(name: "example", pattern: "k(?:a|b){6,}", ignoreCase: false, replacement: Redactor.placeholder)
        let gone = Redactor.placeholder
        #expect(Redactor.redact([["one kaaaaaab two"], ["three"]], with: [greedy]) == [["one \(gone) two"], ["three"]])
        let run = "k" + String(repeating: "a", count: 2_000_000)
        #expect(Redactor.redact([["one kaaaaaab two "], [run, "selected"], ["after"]], with: [greedy]) == [["one \(gone)\(gone)"], ["", ""], [""]])
        // With no match before the run, everything is withheld.
        #expect(Redactor.redact([["before secretword ", run], ["after"]], with: [greedy]) == [[gone, ""], [""]])
    }

    /// A label on screen and the focused field holding its value are one secret: the field's texts
    /// are redacted with the blocks around them, not by themselves.
    @Test func aSecretSplitBetweenALabelAndTheFocusedFieldIsRedacted() {
        let gone = Redactor.placeholder
        var context = ScreenContext(appName: "Example Browser")
        context.append(.text, "API token:")
        context.textBeforeCaret = "abc123" + "def456"
        context.appendCaret()
        var reply = context.json
        #expect(reply["textBeforeCaret"]?.string == gone)
        #expect(reply["renderedText"]?.string == "API token:\n» \(gone)‸")

        // The token selected under its label: the selection is a secret's.
        context = ScreenContext(appName: "Example Browser")
        context.append(.text, "Authorization: Bearer")
        context.selectedText = "a1B2c3D4e5F6g7H8" + "i9J0k1L2"
        context.appendCaret()
        reply = context.json
        #expect(reply["selectedText"]?.string == gone)
        #expect(reply["selectionRedacted"] == .bool(true))
        #expect(reply["renderedText"]?.string == "Authorization: Bearer\n» ‸\(gone)‸")

        // No block for the focused field: its texts follow the last block.
        context = ScreenContext(appName: "Example Browser")
        context.append(.text, "password:")
        context.textBeforeCaret = "hunter" + "22x"
        reply = context.json
        #expect(reply["textBeforeCaret"]?.string == gone)
        #expect(reply["renderedText"]?.string == "password:")
    }

    /// Each block keeps its place on screen through the redaction, the focused field's too: the
    /// visible text is laid out from them (side by side on a line, a blank line at a jump back up).
    @Test func redactedBlocksKeepTheirPlaceOnScreen() {
        let secret = "sk" + "-" + "a1B2c3D4e5F6g7H8i9J0k1L2"
        var context = ScreenContext(appName: "Example Browser")
        context.append(.text, "key", frame: CGRect(x: 0, y: 100, width: 30, height: 20))
        context.append(.text, secret, frame: CGRect(x: 40, y: 100, width: 200, height: 20))
        context.textBeforeCaret = "note "
        context.appendCaret(frame: CGRect(x: 0, y: 200, width: 300, height: 20))
        context.append(.text, "sidebar", frame: CGRect(x: 400, y: 0, width: 80, height: 20))

        #expect(context.json["renderedText"]?.string == "key \(Redactor.placeholder)\n» note ‸\n\nsidebar")
        #expect(context.redacted.blocks.map(\.frame) == context.blocks.map(\.frame))
    }

    /// A selection that begins inside a secret and ends in blank space keeps only the blank: the app
    /// would take that for no selection and paste over the real one, so it is the placeholder too.
    @Test func aSelectionLeftBlankByTheRedactionIsStillASelection() {
        let gone = Redactor.placeholder
        var context = ScreenContext(appName: "Example Terminal")
        context.textBeforeCaret = "export K=" + "sk" + "-" + "a1B2c3D4e5F6g7H8"
        context.selectedText = "i9J0k1L2 "
        context.textAfterCaret = "next"
        var reply = context.json
        #expect(reply["textBeforeCaret"]?.string == "export K=\(gone)")
        #expect(reply["selectedText"]?.string == gone)
        #expect(reply["selectionRedacted"] == .bool(true))

        // The lower lines of a key block, selected with their line break.
        context = ScreenContext(appName: "Example Editor")
        context.textBeforeCaret = "-----BEGIN " + "PRIVATE KEY-----\na1B2c3D4e5F6g7H8\n"
        context.selectedText = "i9J0k1L2m3N4o5P6\n-----END " + "PRIVATE KEY-----\n"
        context.textAfterCaret = "next"
        reply = context.json
        #expect(reply["textBeforeCaret"]?.string == gone)
        #expect(reply["selectedText"]?.string == gone)
        #expect(reply["selectionRedacted"] == .bool(true))

        // Blank space the user selected, with no secret in it, is left as it is.
        context = ScreenContext(appName: "Example Editor")
        context.textBeforeCaret = "token=abc" + "123def"
        context.selectedText = " \n"
        reply = context.json
        #expect(reply["selectedText"]?.string == " \n")
        #expect(reply["selectionRedacted"] == .bool(false))
    }

    /// The focused field's block stays though nothing is left in it, and the focused field's texts
    /// are redacted when the walk placed no block for it.
    @Test func theFocusedFieldIsRedactedWithOrWithoutItsBlock() {
        let secret = "sk" + "-" + "a1B2c3D4e5F6g7H8i9J0k1L2"
        let gone = Redactor.placeholder
        var context = ScreenContext(appName: "Example Editor")
        context.append(.text, "Above")
        context.appendCaret()
        context.append(.text, "Below")
        #expect(context.json["renderedText"]?.string == "Above\n» ‸\nBelow")

        context = ScreenContext(appName: "Example Terminal")
        context.textBeforeCaret = "key \(secret) "
        context.selectedText = "plain"
        context.textAfterCaret = " \(secret)"
        context.append(.field, "echo \(secret)")
        let reply = context.json
        #expect(reply["textBeforeCaret"]?.string == "key \(gone) ")
        #expect(reply["selectedText"]?.string == "plain")
        #expect(reply["textAfterCaret"]?.string == " \(gone)")
        #expect(reply["renderedText"]?.string == "> echo \(gone)")
        #expect(reply["selectionRedacted"] == .bool(false))
        #expect(context.redacted.blocks.count == 1)
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
        let begin = "-----BEGIN "
        let units = ["a.", "token:", "-eyJ", "-----BEGIN A ", "://a:b", "://a:b@", "@://a:b", "Bearer ", "-sk-a", "password" + String(repeating: " ", count: 64), "a"].map { ("", $0) }
            // A key's header, and its footer, naming its kind over and over.
            + [(begin, "PRIVATE KEY "), (begin + "PRIVATE KEY-----\n-----END ", "PRIVATE KEY ")]
        for (start, unit) in units {
            let text = start + String(repeating: unit, count: length / unit.count + 1)
            let elapsed = clock.measure { _ = Redactor.redact(text) }
            #expect(elapsed < .seconds(5), "\(start.prefix(16))\(unit.prefix(16)): \(elapsed)")
        }
    }
}
