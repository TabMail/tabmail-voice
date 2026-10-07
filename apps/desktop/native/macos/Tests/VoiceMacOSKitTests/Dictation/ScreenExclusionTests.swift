// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// An app or a website the user excludes from screen reading is never read: not its screen as a
/// dictation starts, not its focused field after the paste. Over stand-ins that record what was
/// read; no real app is read.
@MainActor
struct ScreenExclusionTests {
    /// What the stand-ins were asked to read.
    private final class Reads: Sendable {
        let screens = OSAllocatedUnfairLock<[String]>(initialState: [])
        let fields = OSAllocatedUnfairLock<[pid_t]>(initialState: [])
        /// The exclusions each read was given.
        let exclusions = OSAllocatedUnfairLock<[ScreenExclusions]>(initialState: [])
    }

    /// The replies to `requests`, with `frontmost` in front and `apps` running (pid to bundle identifier).
    /// The screen stand-in reads a page on `host`, whatever is excluded, or nothing when `refuses`.
    private func replies(
        to requests: [String], frontmost: (pid_t, String, String?)? = (7, "Example Vault", "org.example.vault"),
        apps: [pid_t: String] = [7: "org.example.vault", 8: "org.example.notes"], shown: String = "field text",
        host: String? = nil, refuses: Bool = false, field: FocusedField.Read? = nil
    ) async throws -> (replies: [[String: Any]], reads: Reads) {
        let reads = Reads()
        let screen = ScreenAccess(
            frontmost: { frontmost },
            bundleIdentifier: { apps[$0] },
            read: { pid, name, bundleID, exclusions in
                reads.screens.withLock { $0.append("\(pid) \(name) \(bundleID ?? "-")") }
                reads.exclusions.withLock { $0.append(exclusions) }
                if refuses { return nil }
                var context = ScreenContext(appName: name, bundleID: bundleID)
                context.host = host
                context.append(.text, shown)
                return context
            },
            focusedField: { pid, exclusions in
                reads.fields.withLock { $0.append(pid) }
                reads.exclusions.withLock { $0.append(exclusions) }
                return field ?? .text(shown)
            }
        )
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }), screen: screen
        )
        // The screen read is the reader's (`voice-screen-reader`); one channel serves both here.
        ScreenReaderService.register(on: channel, screen: screen)
        for request in requests { await channel.handle(line: Data(request.utf8)) }
        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        withExtendedLifetime(service) {}
        return (replies, reads)
    }

    /// Whether the reply says the screen is hidden, and nothing else: no field of a context.
    private func isHidden(_ reply: [String: Any]?) -> Bool {
        guard let reply, reply["error"] == nil, let result = reply["result"] as? NSDictionary else { return false }
        return result == ["hidden": true] as NSDictionary
    }

    /// An excluded app in front is not read; the reply says the screen is hidden, and nothing of it.
    @Test func anExcludedAppInFrontIsNotRead() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":["org.example.bank","org.example.vault"],"excludedHosts":[]}}"#,
            #"{"id":2,"method":"readScreen","params":{"excludedAppIDs":["ORG.Example.Vault"],"excludedHosts":[]}}"#,
        ])
        #expect(replies.count == 2)
        #expect(replies.allSatisfy(isHidden))
        #expect(reads.screens.withLock { $0 }.isEmpty)
    }

    @Test func anAppNotExcludedIsRead() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[]}}"#,
            #"{"id":2,"method":"readScreen","params":{"excludedAppIDs":["org.example.bank","org.example.vault.helper","org.example"],"excludedHosts":[]}}"#,
        ])
        #expect(replies.count == 2)
        #expect(replies.allSatisfy { ($0["result"] as? [String: Any])?["appName"] as? String == "Example Vault" })
        #expect(reads.screens.withLock { $0 } == ["7 Example Vault org.example.vault", "7 Example Vault org.example.vault"])
    }

    /// An app without a bundle identifier can't be excluded, and is read; with no app in front
    /// nothing is, and nothing is hidden.
    @Test func anAppWithoutAnIdentifierIsReadAndNoAppIsNot() async throws {
        let request = #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":["org.example.vault"],"excludedHosts":[]}}"#
        let (bare, bareReads) = try await replies(to: [request], frontmost: (9, "Tool", nil))
        #expect((bare.first?["result"] as? [String: Any])?["appName"] as? String == "Tool")
        #expect(bareReads.screens.withLock { $0 } == ["9 Tool -"])

        let (none, noReads) = try await replies(to: [request], frontmost: nil)
        #expect(none.first?["result"] is NSNull)
        #expect(noReads.screens.withLock { $0 }.isEmpty)
    }

    /// A request that doesn't say which apps and which websites are excluded is refused, and nothing
    /// is read.
    @Test func aRequestWithoutTheExclusionsReadsNothing() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"readScreen","params":{}}"#,
            #"{"id":2,"method":"readScreen","params":{"excludedAppIDs":"org.example.vault","excludedHosts":[]}}"#,
            #"{"id":3,"method":"readScreen","params":{"excludedAppIDs":["org.example.bank",7],"excludedHosts":[]}}"#,
            #"{"id":4,"method":"readScreen","params":{"excludedAppIDs":[]}}"#,
            #"{"id":5,"method":"readScreen","params":{"excludedHosts":[]}}"#,
            #"{"id":6,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":"example.com"}}"#,
            #"{"id":7,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":["example.com",null]}}"#,
            #"{"id":8,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100}}"#,
            #"{"id":9,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":[null],"excludedHosts":[]}}"#,
            #"{"id":10,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":[]}}"#,
            #"{"id":11,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedHosts":[]}}"#,
            #"{"id":12,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":[],"excludedHosts":[7]}}"#,
        ])
        #expect(replies.count == 12)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
        #expect(reads.screens.withLock { $0 }.isEmpty)
        #expect(reads.fields.withLock { $0 }.isEmpty)
    }

    @Test func theFocusedFieldOfAnExcludedAppIsNotRead() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"focusedFieldValue","params":{"pid":7,"maxLength":100,"excludedAppIDs":["Org.Example.Vault"],"excludedHosts":[]}}"#,
            #"{"id":2,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":["org.example.vault"],"excludedHosts":[]}}"#,
            #"{"id":3,"method":"focusedFieldValue","params":{"pid":99,"maxLength":100,"excludedAppIDs":["org.example.vault"],"excludedHosts":[]}}"#,
        ])
        #expect(replies.count == 3)
        guard replies.count == 3 else { return }
        let values = replies.map { ($0["result"] as? [String: Any])?["value"] }
        #expect(values[0] is NSNull)
        #expect(values[1] as? String == "field text")
        // A process with no bundle identifier (or gone) can't be excluded.
        #expect(values[2] as? String == "field text")
        #expect(reads.fields.withLock { $0 } == [8, 99])
    }

    @Test func excludedAppsAreMatchedWholeWhateverTheCase() throws {
        #expect(ScreenExclusions(appIDs: ["org.example.bank", "COM.EXAMPLE.vault"]).excludesApp("com.example.Vault"))
        #expect(!ScreenExclusions().excludesApp("com.example.vault"))
        #expect(!ScreenExclusions(appIDs: ["com.example", "com.example.vault.helper", "example.vault"]).excludesApp("com.example.vault"))
        #expect(!ScreenExclusions(appIDs: ["com.example.vault", ""]).excludesApp(nil))
        // A website's host excludes no app, and an app's identifier no website.
        #expect(!ScreenExclusions(hosts: ["com.example.vault"]).excludesApp("com.example.vault"))
        #expect(!ScreenExclusions(appIDs: ["example.com"]).excludesHost("example.com"))
    }

    @Test func sharedUnicodePolicyAndFailureRefusal() throws {
        let policy = ScreenExclusions(appIDs: ["Straße", "é"], hosts: ["Straße.example"])
        #expect(policy.excludesApp("STRASSE"))
        #expect(policy.excludesApp("e\u{301}"))
        #expect(policy.excludesHost("sub.STRASSE.example."))
        // Nonthrowing read guards must refuse when the shared core rejects input.
        #expect(policy.excludesApp("invalid\0identity"))
        #expect(policy.excludesHost(String(repeating: "x", count: 32769)))
        #expect(throws: (any Error).self) {
            try ScreenExclusions(params: .object(["excludedAppIDs": .array([.string("bad\0id")]), "excludedHosts": .array([])]), method: "readScreen")
        }
    }

    // MARK: Websites

    private struct HostCases: Decodable {
        struct Case: Decodable {
            let name: String
            let site: String
            let host: String
            let excluded: Bool
        }
        let cases: [Case]
    }

    /// The cases every platform's helper shares (`native/shared/privacy/host-exclusion-cases.json`).
    @Test func hostsAreExcludedAsTheSharedCasesSay() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../shared/privacy/host-exclusion-cases.json").standardizedFileURL
        let cases = try JSONDecoder().decode(HostCases.self, from: Data(contentsOf: file)).cases
        #expect(cases.count >= 15)
        #expect(cases.contains { $0.excluded } && cases.contains { !$0.excluded })
        for item in cases {
            #expect(ScreenExclusions(hosts: [item.site]).excludesHost(item.host) == item.excluded, "\(item.name)")
        }
        #expect(!ScreenExclusions(hosts: ["example.com"]).excludesHost(nil))
        #expect(ScreenExclusions(hosts: ["example.org", "example.com"]).excludesHost("mail.example.com"))
    }

    private struct PolicyCases: Decodable {
        struct Case: Decodable {
            let name: String
            let input: JSON
            let output: [String: Bool]?
            let refused: Bool?
        }
        let cases: [Case]
    }

    /// The shared policy cases (`native/shared/privacy/policy-cases.json`), through the wrapper the
    /// screen reads use. A refused case is refused when the lists are read, or every answer it asks
    /// for is "excluded" (a core failure never allows a read). Two can't be asked of the wrapper: a
    /// page of a kind that is no `PageHost`, and a page said to have a host with none.
    @Test func policyIsAsTheSharedCasesSay() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../shared/privacy/policy-cases.json").standardizedFileURL
        let cases = try JSONDecoder().decode(PolicyCases.self, from: Data(contentsOf: file)).cases
        #expect(cases.contains { $0.refused == true } && cases.contains { $0.output != nil })
        for item in cases {
            guard case let .object(input) = item.input else { Issue.record("\(item.name): input is no object"); continue }
            guard let exclusions = try? ScreenExclusions(params: item.input, method: "readScreen") else {
                #expect(item.refused == true, "\(item.name): the lists were refused")
                continue
            }
            var answers: [String: Bool] = [:]
            if let app = input["app"] { answers["app"] = exclusions.excludesApp(app.string) }
            if let host = input["host"] { answers["host"] = exclusions.excludesHost(host.string) }
            if let page = input["page"] {
                switch page.string {
                case "unknown": answers["page"] = exclusions.excludes(.unknown)
                case "noHost": answers["page"] = exclusions.excludes(.noHost)
                case "host": if let host = input["host"]?.string { answers["page"] = exclusions.excludes(.host(host)) }
                default: break
                }
            }
            if item.refused == true {
                #expect(["unknown page enum", "missing page host"].contains(item.name) || (!answers.isEmpty && answers.values.allSatisfy { $0 }), "\(item.name)")
            } else {
                #expect(answers == item.output, "\(item.name)")
            }
        }
    }

    private func page(_ host: String, _ text: String) -> FakeElement {
        FakeElement("AXWebArea", ["host": host], children: [FakeElement("AXStaticText", [kAXValueAttribute: text])])
    }

    private func walk(_ window: FakeElement, focused: FakeElement? = nil, focusPath: [FakeElement] = [],
                      excluding hosts: [String]) -> (read: Bool, text: String) {
        var context = ScreenContext(appName: "Example")
        let read = ScreenContextReader.walk(window, in: FakeScreenTree(), frame: nil, focused: focused, focusPath: focusPath,
                                            excluding: ScreenExclusions(hosts: hosts), into: &context)
        return (read, try! context.renderedText())
    }

    /// A window showing a page of an excluded website is refused whole, in focus or not: with the
    /// caret in the browser's address field the page is still on screen.
    @Test func aWindowShowingAnExcludedWebsiteIsNotRead() throws {
        let shown = page("vault.example.com", "account 1234")
        let window = FakeElement("AXWindow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "Toolbar"]), shown])
        #expect(!walk(window, excluding: ["example.org", "Example.com"]).read)
        #expect(!walk(window, excluding: ["vault.example.com"]).read)

        let read = walk(window, excluding: ["example.org", "mail.example.com"])
        #expect(read.read)
        #expect(read.text == "Toolbar\naccount 1234")
        #expect(walk(window, excluding: []).read)
    }

    /// The page the caret is in is on the focus path, which the walk goes into without reading it.
    @Test func aFocusedPageOfAnExcludedWebsiteIsNotRead() throws {
        let field = FakeElement("AXTextField", [kAXValueAttribute: "typed"])
        let area = FakeElement("AXWebArea", ["host": "vault.example.com"], children: [field])
        let window = FakeElement("AXWindow", children: [area])
        #expect(!walk(window, focused: field, focusPath: [area, window], excluding: ["example.com"]).read)
        #expect(walk(window, focused: field, focusPath: [area, window], excluding: ["example.org"]).read)
    }

    /// A page of an excluded website framed inside another page.
    @Test func anExcludedWebsiteFramedInAnotherPageIsNotRead() throws {
        let outer = FakeElement("AXWebArea", ["host": "example.org"], children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Outer"]),
            FakeElement("AXGroup", children: [page("pay.example.com", "card 4242")]),
        ])
        let window = FakeElement("AXWindow", children: [outer])
        #expect(!walk(window, excluding: ["example.com"]).read)
        #expect(walk(window, excluding: ["example.net"]) == (true, "Outer\ncard 4242"))
    }

    /// A fake tree that counts what was asked of it: the text around the caret, and any element's
    /// title, value or field text.
    private struct RecordingTree: ScreenTree {
        final class Asked {
            var caret = 0
            var texts = 0
            /// The elements a text was asked of: a title, a description, a value, a field's text, the caret's.
            var elements: Set<ObjectIdentifier> = []
        }
        let asked = Asked()
        private let tree = FakeScreenTree()
        func children(of element: FakeElement) -> [FakeElement] { tree.children(of: element) }
        func frame(of element: FakeElement) -> CGRect? { tree.frame(of: element) }
        func string(_ element: FakeElement, _ name: String) -> String? {
            if name == kAXTitleAttribute || name == kAXValueAttribute { asked.texts += 1 }
            if name == kAXTitleAttribute || name == kAXValueAttribute || name == kAXDescriptionAttribute { asked.elements.insert(ObjectIdentifier(element)) }
            return tree.string(element, name)
        }
        func page(of webArea: FakeElement) -> PageHost { tree.page(of: webArea) }
        func fieldSource(of element: FakeElement, windowFrame: CGRect?) -> [String]? {
            asked.texts += 1
            asked.elements.insert(ObjectIdentifier(element))
            return tree.fieldSource(of: element, windowFrame: windowFrame)
        }
        func caretWindow(of element: FakeElement) -> SharedContext.CaretWindow? {
            asked.caret += 1
            asked.elements.insert(ObjectIdentifier(element))
            return tree.caretWindow(of: element)
        }
        func isSame(_ first: FakeElement, _ second: FakeElement) -> Bool { tree.isSame(first, second) }
        func isEditable(_ element: FakeElement) -> Bool { tree.isEditable(element) }
    }

    private static let caret = ["caretBefore": "account 1234 ", "caretSelected": "balance", "caretAfter": " 99"]

    private func gather(_ window: FakeElement?, focused: FakeElement?, focusPath: [FakeElement],
                        excluding hosts: [String]) -> (read: Bool, context: ScreenContext, asked: RecordingTree.Asked) {
        let start = ScreenContext(appName: "Example")
        let tree = RecordingTree()
        let context = ScreenContextReader.gather(window: window, focused: focused, focusPath: focusPath, in: tree,
                                                 excluding: ScreenExclusions(hosts: hosts), from: start)
        return (context != nil, context ?? start, tree.asked)
    }

    /// A window too large to walk to its end keeps what was read: only a page of an excluded
    /// website refuses a read, not the budget. The walk has no time limit.
    @Test func aReadStoppedByItsBudgetIsKept() throws {
        let texts = (0 ..< HelperConfig.contextNodeBudget + 10).map { FakeElement("AXStaticText", [kAXValueAttribute: "line \($0)"]) }
        let large = gather(FakeElement("AXWindow", [kAXTitleAttribute: "Large"], children: texts), focused: nil, focusPath: [],
                           excluding: ["example.com"])
        #expect(large.read)
        #expect(large.context.stoppedEarly == "node budget")
        #expect(large.context.windowTitle == "Large")
        #expect(large.context.nodesVisited == HelperConfig.contextNodeBudget)
    }

    /// With the caret in a page of an excluded website, nothing is asked of the app: not the text
    /// around the caret, not the window's title, no element's text.
    @Test func thePageTheCaretIsInIsCheckedBeforeAnythingIsRead() throws {
        let field = FakeElement("AXTextField", Self.caret.merging([kAXValueAttribute: "account 1234 balance 99"]) { $1 })
        let group = FakeElement("AXGroup", children: [field])
        let area = FakeElement("AXWebArea", ["host": "vault.example.com"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "Vault"]), group])
        let window = FakeElement("AXWindow", [kAXTitleAttribute: "Vault - Example Browser"], children: [area])

        let refused = gather(window, focused: field, focusPath: [group, area, window], excluding: ["example.org", "Example.com"])
        #expect(!refused.read)
        #expect(refused.asked.caret == 0 && refused.asked.texts == 0)
        #expect(refused.context.windowTitle == nil && refused.context.textBeforeCaret.isEmpty && refused.context.blocks.isEmpty)

        let read = gather(window, focused: field, focusPath: [group, area, window], excluding: ["example.org"])
        #expect(read.read)
        #expect(read.asked.caret == 1)
        #expect(read.context.windowTitle == "Vault - Example Browser")
        #expect(read.context.host == "vault.example.com")
        #expect(try read.context.renderedText() == "Vault\n» account 1234 ‸balance‸ 99")
    }

    /// A page clicked on, or with text selected in it, has the focus itself: it is the page checked.
    @Test func aPageThatHasTheFocusItselfIsNotRead() throws {
        let area = FakeElement("AXWebArea", Self.caret.merging(["host": "vault.example.com"]) { $1 },
                               children: [FakeElement("AXStaticText", [kAXValueAttribute: "account 1234 balance 99"])])
        let window = FakeElement("AXWindow", [kAXTitleAttribute: "Vault"], children: [area])

        let refused = gather(window, focused: area, focusPath: [window], excluding: ["example.com"])
        #expect(!refused.read)
        #expect(refused.asked.caret == 0 && refused.asked.texts == 0)
        // The walk refuses it on its own too.
        #expect(!walk(window, focused: area, focusPath: [window], excluding: ["example.com"]).read)

        let read = gather(window, focused: area, focusPath: [window], excluding: ["example.org"])
        #expect(read.read)
        #expect(read.context.host == "vault.example.com")
        #expect(read.context.selectedText == "balance")
        #expect(walk(window, focused: area, focusPath: [window], excluding: ["example.org"]).read)
    }

    /// A page that has the focus itself is read like any page: what it shows, in order, with the
    /// heading and the field in it. Safari and Chrome give no text around the caret there, and the
    /// page's text is not the caret's.
    @Test func aPageThatHasTheFocusItselfIsReadLikeAnyPage() throws {
        func page(_ attributes: [String: String]) -> (window: FakeElement, area: FakeElement) {
            let area = FakeElement("AXWebArea", attributes.merging(["host": "news.example.org"]) { $1 }, children: [
                FakeElement("AXHeading", [kAXTitleAttribute: "Headlines"]),
                FakeElement("AXStaticText", [kAXValueAttribute: "account 1234 balance 99"]),
                FakeElement("AXTextField", [kAXValueAttribute: "search"]),
                FakeElement("AXTextField", [kAXSubroleAttribute: kAXSecureTextFieldSubrole as String, kAXValueAttribute: "hunter2"]),
            ])
            return (FakeElement("AXWindow", [kAXTitleAttribute: "News"], children: [area]), area)
        }
        // No caret in the page (Safari, Chrome): the page's text, and no caret block.
        let plain = page([:])
        let read = gather(plain.window, focused: plain.area, focusPath: [plain.window], excluding: ["example.com"])
        #expect(read.read)
        #expect(read.context.host == "news.example.org")
        #expect(try read.context.renderedText() == "## Headlines\naccount 1234 balance 99\n> search")
        #expect(!read.context.blocks.contains { $0.kind == .caret })

        // A caret in the page with text selected (Firefox gives the page's text around it): the
        // selection is kept, as the caret block before the page; the text around it is the page's
        // own, read once, by the walk.
        let selected = page(Self.caret)
        let chosen = gather(selected.window, focused: selected.area, focusPath: [selected.window], excluding: ["example.com"])
        #expect(chosen.read)
        #expect(chosen.context.selectedText == "balance")
        #expect(chosen.context.textBeforeCaret.isEmpty && chosen.context.textAfterCaret.isEmpty)
        #expect(try chosen.context.renderedText() == "» ‸balance‸\n## Headlines\naccount 1234 balance 99\n> search")

        // A caret with nothing selected adds no caret block.
        let caret = page(["caretBefore": "account 1234 ", "caretSelected": "", "caretAfter": "balance 99"])
        let placed = gather(caret.window, focused: caret.area, focusPath: [caret.window], excluding: ["example.com"])
        #expect(try placed.context.renderedText() == "## Headlines\naccount 1234 balance 99\n> search")
        #expect(placed.context.textBeforeCaret.isEmpty && placed.context.textAfterCaret.isEmpty)

        // A page that can be edited (a mail being written, an editor's document) is the field the
        // caret is in: its text around the caret is kept as the caret block, and it is not walked
        // into, with or without a selection.
        for selection in ["balance", ""] {
            let editor = page(["editable": "1", "caretBefore": "account 1234 ", "caretSelected": selection, "caretAfter": " 99"])
            let written = gather(editor.window, focused: editor.area, focusPath: [editor.window], excluding: ["example.com"])
            #expect(written.read)
            #expect(written.context.textBeforeCaret == "account 1234 " && written.context.textAfterCaret == " 99")
            #expect(try written.context.renderedText() == (selection.isEmpty ? "» account 1234 ‸ 99" : "» account 1234 ‸balance‸ 99"))
        }
        // One on an excluded website is still refused, by the walk on its own too.
        let vault = FakeElement("AXWebArea", Self.caret.merging(["editable": "1", "host": "vault.example.com"]) { $1 })
        let vaultWindow = FakeElement("AXWindow", children: [vault])
        #expect(!gather(vaultWindow, focused: vault, focusPath: [vaultWindow], excluding: ["example.com"]).read)
        #expect(!walk(vaultWindow, focused: vault, focusPath: [vaultWindow], excluding: ["example.com"]).read)

        // A focused field in the page is still the caret block, with its text around the caret.
        let field = FakeElement("AXTextField", Self.caret)
        let area = FakeElement("AXWebArea", ["host": "news.example.org"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "Page"]), field])
        let window = FakeElement("AXWindow", children: [area])
        let typed = gather(window, focused: field, focusPath: [area, window], excluding: ["example.com"])
        #expect(try typed.context.renderedText() == "Page\n» account 1234 ‸balance‸ 99")
        #expect(typed.context.textBeforeCaret == "account 1234 ")
    }

    /// A focused element that is no field (a list, a row, a group, a button) is read like any
    /// element, where it is: it is no empty caret block with nothing under it read.
    @Test func aFocusedElementThatIsNoFieldIsReadLikeAnyElement() throws {
        let secret = FakeElement("AXTextField", [kAXSubroleAttribute: kAXSecureTextFieldSubrole as String, kAXValueAttribute: "placeholder-secret"])
        func mail(_ attributes: [String: String] = [:]) -> (window: FakeElement, list: FakeElement, row: FakeElement) {
            let row = FakeElement("AXRow", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Sender One"]), FakeElement("AXStaticText", [kAXValueAttribute: "Quarterly plan"]),
            ])
            let list = FakeElement("AXList", attributes, children: [row, FakeElement("AXGroup", children: [secret])])
            let window = FakeElement("AXWindow", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Inbox"]), list, FakeElement("AXTextField", [kAXValueAttribute: "search"]),
            ])
            return (window, list, row)
        }
        let whole = "Inbox\n| Sender One | Quarterly plan\n> search"
        // The list in focus, and a row of it in focus: what the window shows, and no caret block.
        let plain = mail()
        for (focused, path) in [(plain.list, [plain.window]), (plain.row, [plain.list, plain.window])] {
            let read = gather(plain.window, focused: focused, focusPath: path, excluding: [])
            #expect(read.read)
            #expect(try read.context.renderedText() == whole)
            #expect(!read.context.blocks.contains { $0.kind == .caret })
            // A password field inside the focused element is asked for nothing.
            #expect(!read.asked.elements.contains(ObjectIdentifier(secret)))
        }
        // The same with no focus at all: the focus takes nothing away.
        #expect(try gather(plain.window, focused: nil, focusPath: [], excluding: []).context.renderedText() == whole)

        // Something selected in it is kept, as the caret block before it; the text around the
        // selection is the element's own, read once, by the walk.
        let selected = mail(Self.caret)
        let chosen = gather(selected.window, focused: selected.list, focusPath: [selected.window], excluding: [])
        #expect(chosen.context.selectedText == "balance")
        #expect(chosen.context.textBeforeCaret.isEmpty && chosen.context.textAfterCaret.isEmpty)
        #expect(try chosen.context.renderedText() == "Inbox\n» ‸balance‸\n| Sender One | Quarterly plan\n> search")

        // A focused button is skipped outside web content like any button, and read inside it.
        let button = FakeElement("AXButton", [kAXTitleAttribute: "Send"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "Inner"])])
        let native = FakeElement("AXWindow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "Draft"]), button])
        let skipped = gather(native, focused: button, focusPath: [native], excluding: [])
        #expect(try skipped.context.renderedText() == "Draft")
        let area = FakeElement("AXWebArea", ["host": "example.org"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "Draft"]), button])
        let web = FakeElement("AXWindow", children: [area])
        #expect(try gather(web, focused: button, focusPath: [area, web], excluding: []).context.renderedText() == "Draft\nSend")

        // Outside the window it is not read, as any element there.
        let frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        let away = FakeElement("AXStaticText", [kAXValueAttribute: "Elsewhere"], frame: CGRect(x: 0, y: 900, width: 100, height: 16))
        let framed = FakeElement("AXWindow", frame: frame, children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Draft"], frame: CGRect(x: 0, y: 10, width: 100, height: 16)), away,
        ])
        #expect(try gather(framed, focused: away, focusPath: [framed], excluding: []).context.renderedText() == "Draft")

        // A field in focus is still the caret block and is not walked into, whatever its role.
        for role in ["AXComboBox", "AXTextArea", "AXTextField"] {
            let field = FakeElement(role, Self.caret, children: [FakeElement("AXStaticText", [kAXValueAttribute: "inner"])])
            let window = FakeElement("AXWindow", children: [field])
            let typed = gather(window, focused: field, focusPath: [window], excluding: [])
            #expect(try typed.context.renderedText() == "» account 1234 ‸balance‸ 99")
        }
    }

    /// The walk into a page that has the focus refuses an excluded page framed in it, on its own,
    /// and reads nothing inside a password field there.
    @Test func theWalkIntoAFocusedPageRefusesAnExcludedPageFramedInIt() throws {
        let frame = FakeElement("AXWebArea", ["host": "pay.example.com"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "card 4242"])])
        let outer = FakeElement("AXWebArea", ["host": "example.org"], children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Checkout"]), FakeElement("AXGroup", children: [frame]),
        ])
        let window = FakeElement("AXWindow", children: [outer])
        #expect(!walk(window, focused: outer, focusPath: [window], excluding: ["example.com"]).read)
        let read = walk(window, focused: outer, focusPath: [window], excluding: ["example.net"])
        #expect(read.read && read.text == "Checkout\ncard 4242")

        // What is in a focused page is in web content: a toolbar's text is read there, as in a
        // page that is not in focus, and is skipped outside one.
        let toolbar = FakeElement("AXToolbar", children: [FakeElement("AXStaticText", [kAXValueAttribute: "Project chat"])])
        let page = FakeElement("AXWebArea", ["host": "example.org"], children: [toolbar])
        let shown = FakeElement("AXWindow", children: [page])
        #expect(walk(shown, focused: page, focusPath: [shown], excluding: []).text == "Project chat")
        #expect(walk(shown, excluding: []).text == "Project chat")
        #expect(walk(FakeElement("AXWindow", children: [toolbar]), excluding: []).text == "")
    }

    /// An excluded page framed in another page, with the focus in it or on it.
    @Test func anExcludedFramedPageInFocusIsNotRead() throws {
        let field = FakeElement("AXTextField", Self.caret)
        let frame = FakeElement("AXWebArea", Self.caret.merging(["host": "pay.example.com"]) { $1 }, children: [field])
        let group = FakeElement("AXGroup", children: [frame])
        let outer = FakeElement("AXWebArea", ["host": "example.org"], children: [group])
        let window = FakeElement("AXWindow", children: [outer])
        for (focused, path) in [(field, [frame, group, outer, window]), (frame, [group, outer, window])] {
            let refused = gather(window, focused: focused, focusPath: path, excluding: ["example.com"])
            #expect(!refused.read)
            #expect(refused.asked.caret == 0 && refused.asked.texts == 0)
            let read = gather(window, focused: focused, focusPath: path, excluding: ["example.net"])
            #expect(read.read)
            // The page the caret is in is the nearest one.
            #expect(read.context.host == "pay.example.com")
        }
        // The outer page excluded, the framed one not.
        #expect(!gather(window, focused: field, focusPath: [frame, group, outer, window], excluding: ["example.org"]).read)
    }

    /// An excluded page behind more elements than the look's budget, among the last it lists, is
    /// found: in the focused field, before its caret is read, and in text read whole.
    @Test func anExcludedPageBehindAWideElementIsFound() throws {
        let fillers = (0 ..< HelperConfig.contextNodeBudget + 1).map { _ in FakeElement("AXGroup") }
        let page = FakeElement("AXWebArea", ["host": "pay.example.com"])
        let field = FakeElement("AXTextArea", Self.caret, children: fillers + [page])
        let window = FakeElement("AXWindow", [kAXTitleAttribute: "Notes"], children: [field, FakeElement("AXStaticText", [kAXValueAttribute: "Other"])])
        let refused = gather(window, focused: field, focusPath: [window], excluding: ["example.com"])
        #expect(!refused.read && refused.asked.caret == 0)
        let text = FakeElement("AXStaticText", [kAXValueAttribute: "Label"], children: fillers + [page])
        #expect(!gather(FakeElement("AXWindow", children: [text]), focused: nil, focusPath: [], excluding: ["example.com"]).read)
    }

    /// An excluded page wholly outside the window is skipped with what it holds, like any element
    /// there: the window it is not shown in is read (ADR-DESK-047, 2026-10-01).
    @Test func anExcludedPageOutsideTheWindowIsSkipped() throws {
        let away = FakeElement("AXWebArea", ["host": "pay.example.com"], frame: CGRect(x: 0, y: 900, width: 400, height: 300),
                               children: [FakeElement("AXStaticText", [kAXValueAttribute: "card 4242"])])
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 400, height: 300),
                                 children: [FakeElement("AXStaticText", [kAXValueAttribute: "Visible"]), away])
        let read = gather(window, focused: nil, focusPath: [], excluding: ["example.com"])
        #expect(read.read)
        #expect(try read.context.renderedText() == "Visible")
    }

    /// With the caret outside every page (the browser's address field), a page of an excluded
    /// website elsewhere in the window still refuses the window; a page not excluded gives the host.
    @Test func aWindowIsRefusedForAPageTheCaretIsNotIn() throws {
        let address = FakeElement("AXTextField", Self.caret)
        let window = FakeElement("AXWindow", [kAXTitleAttribute: "Vault"], children: [address, page("vault.example.com", "account 1234")])
        #expect(!gather(window, focused: address, focusPath: [window], excluding: ["example.com"]).read)
        #expect(!gather(window, focused: nil, focusPath: [], excluding: ["example.com"]).read)

        let read = gather(window, focused: address, focusPath: [window], excluding: ["example.org"])
        #expect(read.read)
        #expect(read.context.host == "vault.example.com")
        #expect(try read.context.renderedText() == "» account 1234 ‸balance‸ 99\naccount 1234")
        // No window: the caret's text alone.
        let alone = gather(nil, focused: address, focusPath: [], excluding: ["example.com"])
        #expect(alone.read && alone.context.textBeforeCaret == "account 1234 " && alone.context.blocks.isEmpty)
    }

    /// A page of an excluded website framed inside a row, a heading or a link, whose text the walk
    /// gathers in one piece.
    @Test(arguments: ["AXRow", "AXHeading", "AXLink"])
    func anExcludedWebsiteFramedInARowAHeadingOrALinkIsNotRead(role: String) {
        let window = FakeElement("AXWindow", children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Outer"]),
            FakeElement(role, children: [FakeElement("AXGroup", children: [page("pay.example.com", "card 4242")])]),
        ])
        #expect(!walk(window, excluding: ["example.com"]).read)
        let read = walk(window, excluding: ["example.net"])
        #expect(read.read)
        #expect(read.text.contains("card 4242"))
    }

    /// A page of an excluded website framed inside a field, in the window or in a row: a field is
    /// read by its value and never walked into, so the page is looked for first. The field is not
    /// read and a marker stands in its place; the rest of the window is read. So with the page
    /// framed in another website's page there. A field too thin to show anything is not read
    /// either way, and leaves no marker.
    @Test(arguments: ["AXTextArea", "AXTextField"], [true, false])
    func aFieldFramingAnExcludedWebsiteIsMarkedHiddenAndTheRestRead(role: String, inRow: Bool) throws {
        let excluded = page("pay.example.com", "card 4242")
        let shown = CGRect(x: 10, y: 40, width: 200, height: 40)
        let shapes: [(name: String, frame: CGRect, inside: FakeElement)] = [
            ("shown", shown, FakeElement("AXGroup", children: [excluded])),
            ("too thin to show", CGRect(x: 10, y: 40, width: 200, height: 1), FakeElement("AXGroup", children: [excluded])),
            ("in another page", shown, FakeElement("AXWebArea", ["host": "news.example.org"], children: [excluded])),
        ]
        let marker = try SharedContext.hiddenMarker()
        for shape in shapes {
            let field = FakeElement(role, [kAXValueAttribute: "Field words"], frame: shape.frame, children: [shape.inside])
            let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 400, height: 300), children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Outer"], frame: CGRect(x: 10, y: 10, width: 100, height: 16)),
                inRow ? FakeElement("AXRow", frame: shown, children: [FakeElement("AXCell", children: [
                    FakeElement("AXStaticText", [kAXValueAttribute: "10:15"], frame: CGRect(x: 10, y: 40, width: 40, height: 16)), field,
                ])]) : field,
                FakeElement("AXStaticText", [kAXValueAttribute: "After"], frame: CGRect(x: 10, y: 100, width: 100, height: 16)),
            ])
            let isShown = shape.name != "too thin to show"
            let hidden = walk(window, excluding: ["example.com"])
            #expect(hidden.read, "\(shape.name)")
            #expect(!hidden.text.contains("Field words") && !hidden.text.contains("card 4242"), "\(shape.name)")
            let place = inRow ? (isShown ? "| 10:15 | \(marker)" : "| 10:15") : (isShown ? "> \(marker)" : nil)
            #expect(hidden.text == ["Outer", place, "After"].compactMap { $0 }.joined(separator: "\n"), "\(shape.name)")

            let read = walk(window, excluding: ["example.net"])
            #expect(read.read, "\(shape.name)")
            #expect(read.text.contains("Field words") == isShown, "\(shape.name)")
            #expect(!read.text.contains(marker), "\(shape.name)")
        }
    }

    /// A field too large to look through is not read either: the look gives up at the element
    /// budget, and a page it did not reach might be an excluded one. One element fewer, and the
    /// field is looked through whole and read.
    @Test(arguments: ["AXTextArea", "AXTextField"], [true, false])
    func aFieldTooLargeToLookThroughIsMarkedHidden(role: String, inRow: Bool) throws {
        let shown = CGRect(x: 10, y: 40, width: 200, height: 40)
        func read(fillers: Int, behind host: String?) -> String {
            // The look takes the last child first: the page, when there is one, is reached last.
            let page = host.map { [self.page($0, "card 4242")] } ?? []
            let field = FakeElement(role, [kAXValueAttribute: "Field words"], frame: shown,
                                    children: page + (0..<fillers).map { _ in FakeElement("AXGroup") })
            let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 400, height: 300), children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Outer"], frame: CGRect(x: 10, y: 10, width: 100, height: 16)),
                inRow ? FakeElement("AXRow", frame: shown, children: [FakeElement("AXCell", children: [field])]) : field,
                FakeElement("AXStaticText", [kAXValueAttribute: "After"], frame: CGRect(x: 10, y: 100, width: 100, height: 16)),
            ])
            let result = walk(window, excluding: ["example.com"])
            #expect(result.read)
            return result.text
        }
        let mark = inRow ? "| " : "> "
        let marker = try SharedContext.hiddenMarker()
        let hidden = "Outer\n\(mark)\(marker)\nAfter"
        let budget = HelperConfig.contextNodeBudget
        // One element more than the look takes in: hidden whether the one not reached is an
        // excluded page or nothing of the kind.
        #expect(read(fillers: budget, behind: "pay.example.com") == hidden)
        #expect(read(fillers: budget + 1, behind: nil) == hidden)
        // Looked through whole: the excluded page is found, and a field without one is read.
        #expect(read(fillers: budget - 1, behind: "pay.example.com") == hidden)
        #expect(read(fillers: budget, behind: nil) == "Outer\n\(mark)Field words\nAfter")
    }

    /// The same with a label of its own, and for a piece of text and a web control with a title:
    /// such an element is read in one piece and never walked into, and its label can be made of
    /// what it holds, so it is looked through and the window refused.
    @Test(arguments: ["AXRow", "AXHeading", "AXLink", "AXStaticText", "AXButton"])
    func anExcludedWebsiteInsideALabelledElementIsNotRead(role: String) {
        func window(frame: CGRect? = nil) -> (window: FakeElement, holder: FakeElement) {
            let holder = FakeElement(role, [kAXTitleAttribute: "Pay now", kAXValueAttribute: "Pay now"], frame: frame,
                                     children: [FakeElement("AXGroup", children: [page("pay.example.com", "card 4242")])])
            let area = FakeElement("AXWebArea", ["host": "example.org"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "Outer"]), holder])
            return (FakeElement("AXWindow", children: [area]), holder)
        }
        let shown = window()
        let refused = gather(shown.window, focused: nil, focusPath: [], excluding: ["example.com"])
        #expect(!refused.read && refused.context.blocks.isEmpty)
        #expect(!walk(shown.window, excluding: ["example.com"]).read)

        // Common row policy prefers permitted descendants; other semantic kinds
        // use an approved root label. The excluded variant above still refuses.
        let read = walk(shown.window, excluding: ["example.net"])
        #expect(read.read)
        if role == "AXRow" { #expect(read.text.contains("card 4242") && !read.text.contains("Pay now")) }
        else { #expect(read.text.contains("Pay now") && !read.text.contains("card 4242")) }

        // One too thin to show anything is not read, but is looked through: the page it holds may
        // still be on screen, and refuses the window (ADR-DESK-047).
        let thin = window(frame: CGRect(x: 0, y: 0, width: 200, height: 1))
        #expect(!walk(thin.window, excluding: ["example.com"]).read)
        let hidden = walk(thin.window, excluding: ["example.net"])
        #expect(hidden.read && hidden.text == "Outer")

        // Inside a row with no label, whose text is gathered: a piece of text or a titled control
        // that holds the page refuses the window there too.
        if role == "AXStaticText" || role == "AXButton" {
            let row = FakeElement("AXRow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "10:15"]), shown.holder])
            let area = FakeElement("AXWebArea", ["host": "example.org"], children: [row])
            let inRow = FakeElement("AXWindow", children: [area])
            #expect(!walk(inRow, excluding: ["example.com"]).read)
            #expect(walk(inRow, excluding: ["example.net"]).text == "| 10:15 | Pay now")
            // Too thin to show, it is not read there either, but is looked through.
            let thinRow = FakeElement("AXRow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "10:15"]), thin.holder])
            let thinWindow = FakeElement("AXWindow", children: [FakeElement("AXWebArea", ["host": "example.org"], children: [thinRow])])
            #expect(!walk(thinWindow, excluding: ["example.com"]).read)
            let thinInRow = walk(thinWindow, excluding: ["example.net"])
            #expect(thinInRow.read && thinInRow.text == "| 10:15")
        }

        // The page framed in another website's page inside it is found too.
        let framed = FakeElement(role, [kAXTitleAttribute: "Pay now", kAXValueAttribute: "Pay now"], children: [
            FakeElement("AXWebArea", ["host": "news.example.org"], children: [page("pay.example.com", "card 4242")]),
        ])
        let outer = FakeElement("AXWindow", children: [FakeElement("AXWebArea", ["host": "example.org"], children: [framed])])
        #expect(!walk(outer, excluding: ["example.com"]).read)

        // A page whose address the app failed to give can't be told safe: held by such an
        // element it refuses the window with nothing excluded at all. A page with no address is read.
        func holding(_ attributes: [String: String]) -> FakeElement {
            FakeElement(role, [kAXTitleAttribute: "Pay now", kAXValueAttribute: "Pay now"], children: [FakeElement("AXWebArea", attributes)])
        }
        func inWindow(_ element: FakeElement) -> FakeElement {
            FakeElement("AXWindow", children: [FakeElement("AXWebArea", ["host": "example.org"], children: [element])])
        }
        #expect(!walk(inWindow(holding(["hostUnknown": "1"])), excluding: []).read)
        let noAddress = walk(inWindow(holding([:])), excluding: ["example.com"])
        #expect(noAddress.read && noAddress.text.contains("Pay now"))
        // Both, the framed page and the unknown one, inside a row with no label.
        if role == "AXStaticText" || role == "AXButton" {
            #expect(!walk(inWindow(FakeElement("AXRow", children: [framed])), excluding: ["example.com"]).read)
            #expect(!walk(inWindow(FakeElement("AXRow", children: [holding(["hostUnknown": "1"])])), excluding: []).read)
            #expect(walk(inWindow(FakeElement("AXRow", children: [holding([:])])), excluding: ["example.com"]).text == "| Pay now")
        }
    }

    /// Such an element too large to look through is not read: the look gives up at the element
    /// budget, and a page it did not reach might be an excluded one. The marker stands in its
    /// place and the rest is read. One element fewer, and it is looked through whole.
    @Test(arguments: ["AXRow", "AXHeading", "AXLink", "AXStaticText", "AXButton"], [true, false])
    func aLabelledElementTooLargeToLookThroughIsMarkedHidden(role: String, inRow: Bool) throws {
        func read(fillers: Int, behind host: String?) -> (read: Bool, text: String) {
            // The look takes the last child first: the page, when there is one, is reached last.
            let page = host.map { [self.page($0, "card 4242")] } ?? []
            let holder = FakeElement(role, [kAXTitleAttribute: "Pay now", kAXValueAttribute: "Pay now"],
                                     children: page + (0..<fillers).map { _ in FakeElement("AXGroup") })
            let area = FakeElement("AXWebArea", ["host": "example.org"], children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Outer"]),
                inRow ? FakeElement("AXRow", children: [holder]) : holder,
                FakeElement("AXStaticText", [kAXValueAttribute: "After"]),
            ])
            return walk(FakeElement("AXWindow", children: [area]), excluding: ["example.com"])
        }
        // Inside a row with no label only a piece of text and a titled control are read in one
        // piece; a row, heading or link there is walked into.
        guard !inRow || role == "AXStaticText" || role == "AXButton" else { return }
        let marker = try SharedContext.hiddenMarker()
        let budget = HelperConfig.contextNodeBudget
        if role == "AXRow" && !inRow {
            // Descendant-first traversal reaches the excluded page before the
            // fillers. A budget stop with no text must never read the root label.
            #expect(!read(fillers: budget, behind: "pay.example.com").read)
            let partial = read(fillers: budget + 1, behind: nil)
            #expect(partial.read && partial.text == "Outer")
            let exhausted = read(fillers: budget, behind: nil)
            #expect(exhausted.read && exhausted.text == "Outer")
            let complete = read(fillers: budget - 6, behind: nil)
            #expect(complete.read && complete.text.contains("Pay now") && complete.text.hasSuffix("\nAfter"))
            return
        }
        for hidden in [read(fillers: budget, behind: "pay.example.com"), read(fillers: budget + 1, behind: nil)] {
            #expect(hidden.read)
            #expect(hidden.text.contains(marker) && !hidden.text.contains("Pay now"))
            #expect(hidden.text.hasPrefix("Outer\n") && hidden.text.hasSuffix("\nAfter"))
        }
        // Looked through whole: the excluded page is found, and an element without one is read.
        #expect(!read(fillers: budget - 1, behind: "pay.example.com").read)
        let whole = read(fillers: budget, behind: nil)
        #expect(whole.read && whole.text.contains("Pay now") && !whole.text.contains(marker))
    }

    /// A web control with no title of its own is walked into, not read in one piece: a field in
    /// it that frames an excluded page keeps its marker, and the rest of the window is read.
    @Test(arguments: [[kAXDescriptionAttribute: "Copy"], [:]])
    func aWebControlWithoutATitleIsWalkedIntoNotLookedThrough(attributes: [String: String]) throws {
        let field = FakeElement("AXTextField", [kAXValueAttribute: "Field words"], children: [page("pay.example.com", "card 4242")])
        let area = FakeElement("AXWebArea", ["host": "example.org"], children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Outer"]), FakeElement("AXButton", attributes, children: [field]),
        ])
        let read = walk(FakeElement("AXWindow", children: [area]), excluding: ["example.com"])
        let marker = try SharedContext.hiddenMarker()
        #expect(read.read && read.text == "Outer\n> \(marker)")
    }

    /// A password field is asked for no text, and neither is anything inside it: in the window, in
    /// a row, as a control with a title, and with the focus. What is beside it is asked and read.
    @Test func noTextIsAskedOfAPasswordField() throws {
        let secure = [kAXSubroleAttribute: kAXSecureTextFieldSubrole as String, kAXValueAttribute: "placeholder-secret", kAXTitleAttribute: "placeholder-secret"]
        func field() -> FakeElement {
            FakeElement("AXTextField", secure, children: [FakeElement("AXStaticText", [kAXValueAttribute: "placeholder-secret"])])
        }
        let focused = FakeElement("AXTextField", secure.merging(Self.caret) { $1 })
        let passwords = [field(), field(), FakeElement("AXButton", secure), FakeElement("AXTextArea", secure), focused]
        let name = FakeElement("AXTextField", [kAXValueAttribute: "name1"])
        let label = FakeElement("AXStaticText", [kAXValueAttribute: "Sign in"])
        let window = FakeElement("AXWindow", children: [
            name, passwords[0], FakeElement("AXRow", children: [label, passwords[1]]),
            FakeElement("AXWebArea", ["host": "example.org"], children: [passwords[2], passwords[3]]), focused,
        ])
        let read = gather(window, focused: focused, focusPath: [window], excluding: [])
        #expect(read.read && read.asked.caret == 0)
        for password in passwords {
            #expect(!read.asked.elements.contains(ObjectIdentifier(password)))
            for child in password.children { #expect(!read.asked.elements.contains(ObjectIdentifier(child))) }
        }
        #expect(read.asked.elements.contains(ObjectIdentifier(name)) && read.asked.elements.contains(ObjectIdentifier(label)))
        #expect(try read.context.renderedText().contains("name1") && read.context.renderedText().contains("Sign in"))
        #expect(try !read.context.renderedText().contains("placeholder") && read.context.selectedText.isEmpty)
    }

    /// The field read for correction learning: a password field's value is never asked for.
    @Test func aPasswordFieldsValueIsNotAskedForCorrections() throws {
        func value(_ attributes: [String: String]) -> (value: String?, asked: Int) {
            let field = FakeElement("AXTextField", attributes.merging([kAXValueAttribute: "hunter2x"]) { $1 })
            let tree = RecordingTree()
            let value = FocusedField.value(of: field, above: [FakeElement("AXWindow", children: [field])], in: tree,
                                           excluding: ScreenExclusions())
            return (value, tree.asked.texts)
        }
        #expect(value([kAXSubroleAttribute: kAXSecureTextFieldSubrole as String]) == (nil, 0))
        #expect(value([:]) == ("hunter2x", 1))
    }

    /// A page that frames an excluded one and has the focus itself, or a focused group that holds
    /// one: the walk goes into a focused element that is no field only after its caret's text was
    /// asked for, so it is looked into before anything is read.
    @Test func anExcludedPageInsideTheFocusedElementIsNotRead() throws {
        let frame = FakeElement("AXWebArea", ["host": "pay.example.com"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "card 4242"])])
        let outer = FakeElement("AXWebArea", Self.caret.merging(["host": "example.org"]) { $1 }, children: [FakeElement("AXGroup", children: [frame])])
        let window = FakeElement("AXWindow", [kAXTitleAttribute: "Checkout"], children: [outer])
        let refused = gather(window, focused: outer, focusPath: [window], excluding: ["example.com"])
        #expect(!refused.read)
        #expect(refused.asked.caret == 0 && refused.asked.texts == 0)
        let read = gather(window, focused: outer, focusPath: [window], excluding: ["example.net"])
        #expect(read.read && read.context.selectedText == "balance" && read.context.windowTitle == "Checkout")

        let group = FakeElement("AXGroup", Self.caret, children: [FakeElement("AXGroup", children: [frame])])
        let page = FakeElement("AXWebArea", ["host": "example.org"], children: [group])
        let other = FakeElement("AXWindow", children: [page])
        #expect(!gather(other, focused: group, focusPath: [page, other], excluding: ["example.com"]).read)
        #expect(gather(other, focused: group, focusPath: [page, other], excluding: ["example.net"]).read)
    }

    /// Past the walk's node budget, or the time a look is given (the screen read gives it none),
    /// the focused element is taken to hold no excluded page, as a walk stopped by them keeps its read.
    @Test func theLookInsideTheFocusedElementKeepsToTheBudgets() throws {
        let frame = FakeElement("AXWebArea", ["host": "pay.example.com"])
        func holds(_ element: FakeElement, intoPages: Bool = true, within seconds: Double = .infinity, since started: Date = Date()) -> Bool {
            ScreenContextReader.holdsExcludedPage(element, in: FakeScreenTree(), excluding: ScreenExclusions(hosts: ["example.com"]),
                                                  intoPages: intoPages, within: seconds, since: started)
        }
        // The last child is looked at first: the page is reached after every other child.
        let fillers = (0 ..< HelperConfig.contextNodeBudget).map { _ in FakeElement("AXGroup") }
        #expect(!holds(FakeElement("AXGroup", children: [frame] + fillers)))
        #expect(holds(FakeElement("AXGroup", children: [frame] + fillers.dropLast())))
        // Only visits count: children waiting past the budget do not hide a page the look reaches.
        #expect(holds(FakeElement("AXGroup", children: fillers + [frame])))
        #expect(holds(FakeElement("AXGroup", children: fillers + [FakeElement("AXGroup"), frame])))
        #expect(!holds(FakeElement("AXGroup", children: [frame]), within: HelperConfig.focusedFieldPageScanBudget, since: .distantPast))
        #expect(holds(FakeElement("AXGroup", children: [frame]), within: HelperConfig.focusedFieldPageScanBudget))
        #expect(holds(FakeElement("AXGroup", children: [frame]), since: .distantPast))
        #expect(!holds(frame))
        // A page framed in one that is not excluded is found, unless pages are not looked into.
        let outer = FakeElement("AXGroup", children: [FakeElement("AXWebArea", ["host": "example.org"], children: [frame])])
        #expect(holds(outer))
        #expect(!holds(outer, intoPages: false))
        #expect(holds(FakeElement("AXGroup", children: [FakeElement("AXGroup", children: [frame])]), intoPages: false))
        // A field is read only when all of it was looked through: out of time or of elements, with a
        // page behind them or none, it is taken to hold one.
        func fieldHolds(_ element: FakeElement, within seconds: Double = .infinity, since started: Date = Date()) -> Bool {
            ScreenContextReader.lookForExcludedPage(in: element, FakeScreenTree(), excluding: ScreenExclusions(hosts: ["example.com"]),
                                                    within: seconds, since: started) != ScreenContextReader.PageLook.none
        }
        #expect(fieldHolds(FakeElement("AXTextArea", children: [FakeElement("AXGroup")]), within: HelperConfig.focusedFieldPageScanBudget, since: .distantPast))
        #expect(!fieldHolds(FakeElement("AXTextArea", children: [FakeElement("AXGroup")])))
        #expect(fieldHolds(FakeElement("AXTextArea", children: fillers + [FakeElement("AXGroup")])))
        #expect(!fieldHolds(FakeElement("AXTextArea", children: fillers)))
    }

    /// A page whose address the app failed to give can't be told safe: it is treated as excluded,
    /// wherever it is. A page that has no address is read.
    @Test func aPageWhoseAddressIsUnknownIsNotRead() throws {
        func window(_ attributes: [String: String]) -> (window: FakeElement, area: FakeElement, field: FakeElement) {
            let field = FakeElement("AXTextField", Self.caret.merging([kAXValueAttribute: "typed"]) { $1 })
            let area = FakeElement("AXWebArea", attributes, children: [FakeElement("AXStaticText", [kAXValueAttribute: "Page"]), field])
            return (FakeElement("AXWindow", children: [FakeElement("AXTextField", [kAXValueAttribute: "address"]), area]), area, field)
        }
        let unknown = window(["hostUnknown": "1"]), plain = window([:])
        // In focus, with the focus itself, out of focus, and with nothing excluded at all.
        let inFocus = gather(unknown.window, focused: unknown.field, focusPath: [unknown.area, unknown.window], excluding: ["example.com"])
        #expect(!inFocus.read && inFocus.asked.caret == 0 && inFocus.asked.texts == 0)
        #expect(!gather(unknown.window, focused: unknown.area, focusPath: [unknown.window], excluding: ["example.com"]).read)
        #expect(!gather(unknown.window, focused: nil, focusPath: [], excluding: ["example.com"]).read)
        #expect(!gather(unknown.window, focused: nil, focusPath: [], excluding: []).read)
        let read = gather(plain.window, focused: plain.field, focusPath: [plain.area, plain.window], excluding: ["example.com"])
        #expect(try read.read && read.context.host == nil && read.context.renderedText().contains("Page"))
        // Inside a row with no label of its own, and inside the focused element.
        let row = FakeElement("AXWindow", children: [FakeElement("AXRow", children: [FakeElement("AXWebArea", ["hostUnknown": "1"])])])
        #expect(!gather(row, focused: nil, focusPath: [], excluding: []).read)
        let group = FakeElement("AXGroup", children: [FakeElement("AXWebArea", ["hostUnknown": "1"])])
        let holding = FakeElement("AXWindow", children: [group])
        #expect(!gather(holding, focused: group, focusPath: [holding], excluding: []).read)
        // The focused field read for correction learning.
        #expect(FocusedField.value(of: unknown.field, above: [unknown.area, unknown.window], in: FakeScreenTree(),
                                   excluding: ScreenExclusions()) == nil)
        #expect(FocusedField.value(of: plain.field, above: [plain.area, plain.window], in: FakeScreenTree(),
                                   excluding: ScreenExclusions()) == "typed")

        let exclusions = ScreenExclusions(hosts: ["example.com"])
        #expect(exclusions.excludes(.unknown) && ScreenExclusions().excludes(.unknown))
        #expect(!exclusions.excludes(.noHost))
        #expect(exclusions.excludes(.host("Vault.Example.com")) && !exclusions.excludes(.host("example.org")))
        #expect(PageHost.host("example.org").name == "example.org" && PageHost.noHost.name == nil && PageHost.unknown.name == nil)
    }

    /// What the app's answer says of a page: only an answer that it has no address is no host; any
    /// other failure (the app too slow, or gone) leaves the page unknown.
    @Test func aFailedAddressLookupLeavesThePageUnknown() throws {
        let address = URL(string: "https://vault.example.com/login")! as CFURL
        #expect(ScreenContextReader.page(.success, address: address) == .host("vault.example.com"))
        #expect(ScreenContextReader.page(.success, address: nil) == .noHost)
        #expect(ScreenContextReader.page(.success, address: "" as CFString) == .noHost)
        #expect(ScreenContextReader.page(.noValue, address: nil) == .noHost)
        #expect(ScreenContextReader.page(.attributeUnsupported, address: nil) == .noHost)
        for failure in [AXError.cannotComplete, .failure, .invalidUIElement, .apiDisabled, .notImplemented, .illegalArgument] {
            #expect(ScreenContextReader.page(failure, address: nil) == .unknown)
            #expect(ScreenContextReader.page(failure, address: address) == .unknown)
        }
    }

    @Test func sharedAddressClassification() throws {
        struct Corpus: Decodable {
            struct Item: Decodable { let address: String?; let kind: String; let host: String }
            let cases: [Item]
        }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../shared/privacy/address-cases.json").standardizedFileURL
        for item in try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: file)).cases {
            let page = item.address.map { ScreenContextReader.addressHost(ofAddress: $0 as CFString) } ?? .unknown
            let expected: PageHost = item.kind == "host" ? .host(item.host) : item.kind == "noHost" ? .noHost : .unknown
            #expect(page == expected, "\(item.address ?? "unavailable")")
        }
        #expect(ScreenContextReader.page(.success, address: 7 as CFNumber) == .unknown)
        #expect(ScreenContextReader.page(.success, address: "https://" as CFString) == .unknown)
    }

    /// A page's address as the app gives it (a URL or its text) to the host that is matched.
    @Test func aPagesHostComesFromItsAddress() throws {
        func host(_ address: String) -> String? { ScreenContextReader.host(ofAddress: address as CFString) }
        #expect(host("https://vault.example.com/login?next=a@b#c") == "vault.example.com")
        #expect(host("http://user:secret@example.com:8443/") == "example.com")
        #expect(host("HTTPS://Example.COM/") == "example.com")
        // The match drops a trailing dot and the case; a name outside ASCII comes in its `xn--` form.
        #expect(ScreenExclusions(hosts: ["example.com"]).excludesHost(host("https://Vault.Example.COM./")))
        #expect(host("https://b\u{FC}cher.example/") == "xn--bcher-kva.example")
        // A page that is not a web page gives its scheme, never the random name in its address.
        #expect(host("chrome-extension://abcdefghijklmnop/page.html") == "chrome-extension")
        #expect(host("file:///Users/name1/page.html") == "file")
        #expect(host("about:blank") == "about")
        #expect(host("") == nil)
        #expect(host("no scheme") == nil)
        #expect(ScreenContextReader.host(ofAddress: URL(string: "https://example.org/a")! as CFURL) == "example.org")
        #expect(ScreenContextReader.host(ofAddress: 7 as CFNumber) == nil)
    }

    /// With the caret in a browser's address field, the page the window shows is beside the field,
    /// not above it: the field is not read when its window shows a page of an excluded website.
    @Test func aFieldInAWindowShowingAnExcludedWebsiteIsNotRead() throws {
        func value(_ page: FakeElement, excluding hosts: [String]) -> (value: String?, asked: Int) {
            let address = FakeElement("AXTextField", [kAXValueAttribute: "vault.example.com/items"])
            let toolbar = FakeElement("AXToolbar", children: [address])
            let window = FakeElement("AXWindow", children: [toolbar, FakeElement("AXGroup", children: [page])])
            let tree = RecordingTree()
            let value = FocusedField.value(of: address, above: [toolbar, window], in: tree, excluding: ScreenExclusions(hosts: hosts))
            return (value, tree.asked.texts)
        }
        let vault = FakeElement("AXWebArea", ["host": "vault.example.com"])
        #expect(value(vault, excluding: ["example.com"]) == (nil, 0))
        #expect(value(vault, excluding: ["example.org"]).value == "vault.example.com/items")
        // A page framed in the one shown is not looked for here: the window is looked through every
        // half second, and the frame is not what the address field shows.
        let framing = FakeElement("AXWebArea", ["host": "example.org"], children: [vault])
        #expect(value(framing, excluding: ["example.com"]).value == "vault.example.com/items")
        // A field that itself holds an excluded page is not read, however deep the page.
        let holder = FakeElement("AXTextArea", [kAXValueAttribute: "text"], children: [FakeElement("AXWebArea", ["host": "example.org"], children: [vault])])
        let window = FakeElement("AXWindow", children: [holder])
        #expect(FocusedField.value(of: holder, above: [window], in: FakeScreenTree(), excluding: ScreenExclusions(hosts: ["example.com"])) == nil)
        #expect(FocusedField.value(of: holder, above: [window], in: FakeScreenTree(), excluding: ScreenExclusions(hosts: ["example.net"])) == "text")
        // A field with no window above it is read by its own pages alone.
        #expect(FocusedField.value(of: holder, above: [], in: FakeScreenTree(), excluding: ScreenExclusions(hosts: ["example.net"])) == "text")
    }

    /// The focused field read for correction learning: in a page of an excluded website, or that
    /// page itself, its text is never asked for.
    @Test func theFocusedFieldOfAnExcludedWebsiteIsNotRead() throws {
        let field = FakeElement("AXTextField", [kAXValueAttribute: "account 1234"])
        let area = FakeElement("AXWebArea", ["host": "vault.example.com", kAXValueAttribute: "page text"], children: [field])
        let window = FakeElement("AXWindow", children: [area])
        func value(of element: FakeElement, above path: [FakeElement], excluding hosts: [String]) -> (value: String?, asked: Int) {
            let tree = RecordingTree()
            let value = FocusedField.value(of: element, above: path, in: tree, excluding: ScreenExclusions(hosts: hosts))
            return (value, tree.asked.texts)
        }
        #expect(value(of: field, above: [area, window], excluding: ["example.com"]) == (nil, 0))
        #expect(value(of: area, above: [window], excluding: ["example.com"]) == (nil, 0))
        // The field's own page is told from what is above it, with no window to look through.
        #expect(value(of: field, above: [area], excluding: ["example.com"]) == (nil, 0))
        #expect(value(of: field, above: [area], excluding: ["example.org"]).value == "account 1234")
        #expect(value(of: field, above: [area, window], excluding: ["example.org"]).value == "account 1234")
        #expect(value(of: area, above: [window], excluding: ["example.org"]).value == "page text")
        // A password field is still never read.
        let password = FakeElement("AXTextField", [kAXSubroleAttribute: kAXSecureTextFieldSubrole, kAXValueAttribute: "hunter2"])
        #expect(value(of: password, above: [window], excluding: []).value == nil)
    }

    /// The helper replies that the screen is hidden, and with nothing of it, when the reader refuses,
    /// and drops a context on an excluded host whatever the reader did.
    @Test func aScreenOnAnExcludedWebsiteNeverLeavesTheHelper() async throws {
        let excluding = #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":["example.org","Example.com"]}}"#
        let (refused, refusedReads) = try await replies(to: [excluding], refuses: true)
        #expect(refused.count == 1)
        #expect(isHidden(refused.first))
        #expect(refusedReads.exclusions.withLock { $0 } == [ScreenExclusions(hosts: ["example.org", "Example.com"])])

        let (dropped, _) = try await replies(to: [excluding], host: "vault.example.com")
        #expect(dropped.count == 1)
        #expect(isHidden(dropped.first))

        let (read, _) = try await replies(to: [
            excluding, #"{"id":2,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[]}}"#,
        ], host: "example.net")
        #expect(read.count == 2)
        #expect(read.allSatisfy { ($0["result"] as? [String: Any])?["host"] as? String == "example.net" })
    }

    /// The focused field's reader is told which websites are excluded, with the apps.
    @Test func theFocusedFieldReaderIsGivenTheExclusions() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":["org.example.vault"],"excludedHosts":["example.com"]}}"#,
        ])
        #expect((replies.first?["result"] as? [String: Any])?["value"] as? String == "field text")
        #expect(reads.exclusions.withLock { $0 } == [ScreenExclusions(appIDs: ["org.example.vault"], hosts: ["example.com"])])
    }

    /// A field longer than the request's bound, counted in UTF-16 code units as the app counts (an emoji
    /// is two), is not sent; a bound the shared core refuses is an error (`request-cases.json`).
    @Test func aFieldLongerThanTheBoundIsNotSent() async throws {
        func reply(_ maxLength: String, shown: String) async throws -> [String: Any]? {
            try await replies(to: [#"{"id":1,"method":"focusedFieldValue","params":{"pid":8,"maxLength":\#(maxLength),"excludedAppIDs":[],"excludedHosts":[]}}"#],
                              shown: shown).replies.first
        }
        #expect((try await reply("3", shown: "a😀")?["result"] as? [String: Any])?["value"] as? String == "a😀")
        #expect((try await reply("3", shown: "ab😀")?["result"] as? [String: Any])?["value"] is NSNull)
        #expect(try await reply("0", shown: "a")?["error"] != nil)
        #expect(try await reply("20001", shown: "a")?["error"] != nil)
    }

    /// A terminal's field is the box around its cursor, which the shared core cuts from the viewport
    /// read (`request-cases.json`): the cursor's pane in tmux, its rows joined by the core's breaks
    /// (U+2029); none without an exact caret.
    @Test func aTerminalsFieldIsTheBoxAroundItsCursor() async throws {
        func reply(caret: JSON) async throws -> Any? {
            let text = "log one    │$ echo one\nlog two    │Note: hi"
            let viewport: JSON = ["surfaces": [["id": 1, "frame": [0, 0, 400, 200],
                                                "runs": [["id": 1, "text": .string(text), "connected": false, "startKnown": false, "endKnown": false]],
                                                "selection": ["complete": true, "ranges": []]]],
                                  "focusedSurface": 1, "complete": true, "caret": caret]
            let replies = try await replies(to: [#"{"id":1,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":[],"excludedHosts":[]}}"#],
                                            field: .terminal(viewport)).replies
            return (replies.first?["result"] as? [String: Any])?["value"]
        }
        let end = Double("log one    │$ echo one\nlog two    │Note: hi".utf16.count)
        #expect(try await reply(caret: ["status": "exact", "surface": 1, "run": 1, "offset": .number(end)]) as? String == "$ echo one\u{2029}Note: hi")
        #expect(try await reply(caret: ["status": "outsideViewport"]) is NSNull)
    }

    /// The app the user picks in Settings: its identifier and name, or none for what isn't an app.
    @Test func anAppsIdentifierAndNameComeFromItsPath() async throws {
        let (replies, _) = try await replies(to: [
            #"{"id":1,"method":"appInfo","params":{"path":"/System/Library/CoreServices/Finder.app"}}"#,
            #"{"id":2,"method":"appInfo","params":{"path":"/System/Library/CoreServices"}}"#,
            #"{"id":3,"method":"appInfo","params":{}}"#,
        ])
        #expect(replies.count == 3)
        guard replies.count == 3 else { return }
        let finder = replies[0]["result"] as? [String: Any]
        #expect(finder?["bundleIdentifier"] as? String == "com.apple.finder")
        #expect((finder?["name"] as? String)?.hasPrefix("Finder") == true)
        #expect(replies[1]["result"] is NSNull)
        #expect(replies[2]["error"] != nil)
    }

    /// What the helper sends of an app that is read has secret-looking text taken out (ADR-DESK-046):
    /// the screen read and the focused field alike.
    @Test func secretLookingTextNeverLeavesTheHelper() async throws {
        let secret = "sk" + "-" + "a1B2c3D4e5F6g7H8i9J0k1L2"
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[]}}"#,
            #"{"id":2,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":[],"excludedHosts":[]}}"#,
        ], shown: "export KEY=\(secret) # build")
        #expect(replies.count == 2)
        guard replies.count == 2 else { return }
        #expect(reads.screens.withLock { $0 }.count == 1)
        #expect(reads.fields.withLock { $0 } == [8])
        let screen = try #require(replies[0]["result"] as? [String: Any])
        #expect(screen["renderedText"] as? String == "export KEY=[redacted] # build")
        #expect((screen["logDescription"] as? String)?.contains(secret) == false)
        #expect((replies[1]["result"] as? [String: Any])?["value"] as? String == "export KEY=[redacted] # build")
    }
}
