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
        host: String? = nil, refuses: Bool = false
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
            focusedField: { pid, _, exclusions in
                reads.fields.withLock { $0.append(pid) }
                reads.exclusions.withLock { $0.append(exclusions) }
                return shown
            }
        )
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }), screen: screen
        )
        for request in requests { await channel.handle(line: Data(request.utf8)) }
        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        withExtendedLifetime(service) {}
        return (replies, reads)
    }

    @Test func anExcludedAppInFrontIsNotRead() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":["org.example.bank","org.example.vault"],"excludedHosts":[]}}"#,
            #"{"id":2,"method":"readScreen","params":{"excludedAppIDs":["ORG.Example.Vault"],"excludedHosts":[]}}"#,
        ])
        #expect(replies.count == 2)
        #expect(replies.allSatisfy { $0["result"] is NSNull && $0["error"] == nil })
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
    /// nothing is.
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

    @Test func excludedAppsAreMatchedWholeWhateverTheCase() {
        #expect(ScreenExclusions(appIDs: ["org.example.bank", "COM.EXAMPLE.vault"]).excludesApp("com.example.Vault"))
        #expect(!ScreenExclusions().excludesApp("com.example.vault"))
        #expect(!ScreenExclusions(appIDs: ["com.example", "com.example.vault.helper", "example.vault"]).excludesApp("com.example.vault"))
        #expect(!ScreenExclusions(appIDs: ["com.example.vault", ""]).excludesApp(nil))
        // A website's host excludes no app, and an app's identifier no website.
        #expect(!ScreenExclusions(hosts: ["com.example.vault"]).excludesApp("com.example.vault"))
        #expect(!ScreenExclusions(appIDs: ["example.com"]).excludesHost("example.com"))
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

    private func page(_ host: String, _ text: String) -> FakeElement {
        FakeElement("AXWebArea", ["host": host], children: [FakeElement("AXStaticText", [kAXValueAttribute: text])])
    }

    private func walk(_ window: FakeElement, focused: FakeElement? = nil, focusPath: [FakeElement] = [],
                      excluding hosts: [String]) -> (read: Bool, text: String) {
        var context = ScreenContext(appName: "Example")
        let read = ScreenContextReader.walk(window, in: FakeScreenTree(), frame: nil, focused: focused, focusPath: focusPath,
                                            excluding: ScreenExclusions(hosts: hosts), started: Date(), into: &context)
        return (read, context.renderedText())
    }

    /// A window showing a page of an excluded website is refused whole, in focus or not: with the
    /// caret in the browser's address field the page is still on screen.
    @Test func aWindowShowingAnExcludedWebsiteIsNotRead() {
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
    @Test func aFocusedPageOfAnExcludedWebsiteIsNotRead() {
        let field = FakeElement("AXTextField", [kAXValueAttribute: "typed"])
        let area = FakeElement("AXWebArea", ["host": "vault.example.com"], children: [field])
        let window = FakeElement("AXWindow", children: [area])
        #expect(!walk(window, focused: field, focusPath: [area, window], excluding: ["example.com"]).read)
        #expect(walk(window, focused: field, focusPath: [area, window], excluding: ["example.org"]).read)
    }

    /// A page of an excluded website framed inside another page.
    @Test func anExcludedWebsiteFramedInAnotherPageIsNotRead() {
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
        final class Asked { var caret = 0; var texts = 0 }
        let asked = Asked()
        private let tree = FakeScreenTree()
        func children(of element: FakeElement) -> [FakeElement] { tree.children(of: element) }
        func frame(of element: FakeElement) -> CGRect? { tree.frame(of: element) }
        func string(_ element: FakeElement, _ name: String) -> String? {
            if name == kAXTitleAttribute || name == kAXValueAttribute { asked.texts += 1 }
            return tree.string(element, name)
        }
        func host(of webArea: FakeElement) -> String? { tree.host(of: webArea) }
        func fieldText(of element: FakeElement, windowFrame: CGRect?) -> String? {
            asked.texts += 1
            return tree.fieldText(of: element, windowFrame: windowFrame)
        }
        func caretWindow(of element: FakeElement) -> (String, String, String)? {
            asked.caret += 1
            return tree.caretWindow(of: element)
        }
        func isSame(_ first: FakeElement, _ second: FakeElement) -> Bool { tree.isSame(first, second) }
    }

    private static let caret = ["caretBefore": "account 1234 ", "caretSelected": "balance", "caretAfter": " 99"]

    private func gather(_ window: FakeElement?, focused: FakeElement?, focusPath: [FakeElement], excluding hosts: [String],
                        started: Date = Date(),
                        terminalPane: ((inout ScreenContext) -> Bool)? = nil) -> (read: Bool, context: ScreenContext, asked: RecordingTree.Asked) {
        let start = ScreenContext(appName: "Example")
        let tree = RecordingTree()
        let context = ScreenContextReader.gather(window: window, focused: focused, focusPath: focusPath, in: tree,
                                                 excluding: ScreenExclusions(hosts: hosts), started: started, from: start,
                                                 terminalPane: terminalPane)
        return (context != nil, context ?? start, tree.asked)
    }

    /// A window too large or too slow to walk to its end keeps what was read: only a page of an
    /// excluded website refuses a read, not the budget.
    @Test func aReadStoppedByItsBudgetIsKept() {
        let texts = (0 ..< HelperConfig.contextNodeBudget + 10).map { FakeElement("AXStaticText", [kAXValueAttribute: "line \($0)"]) }
        let large = gather(FakeElement("AXWindow", [kAXTitleAttribute: "Large"], children: texts), focused: nil, focusPath: [], excluding: ["example.com"])
        #expect(large.read)
        #expect(large.context.stoppedEarly == "node budget")
        #expect(large.context.windowTitle == "Large")
        #expect(large.context.nodesVisited == HelperConfig.contextNodeBudget)

        let window = FakeElement("AXWindow", [kAXTitleAttribute: "Slow"], children: [FakeElement("AXStaticText", [kAXValueAttribute: "line"])])
        let slow = gather(window, focused: nil, focusPath: [], excluding: ["example.com"], started: .distantPast)
        #expect(slow.read)
        #expect(slow.context.stoppedEarly == "time budget")
        #expect(slow.context.windowTitle == "Slow")
        #expect(gather(window, focused: nil, focusPath: [], excluding: ["example.com"]).context.stoppedEarly == nil)
    }

    /// With the caret in a page of an excluded website, nothing is asked of the app: not the text
    /// around the caret, not the window's title, no element's text.
    @Test func thePageTheCaretIsInIsCheckedBeforeAnythingIsRead() {
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
        #expect(read.context.renderedText() == "Vault\n» account 1234 ‸balance‸ 99")
    }

    /// A page clicked on, or with text selected in it, has the focus itself: it is the page checked.
    @Test func aPageThatHasTheFocusItselfIsNotRead() {
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

    /// An excluded page framed in another page, with the focus in it or on it.
    @Test func anExcludedFramedPageInFocusIsNotRead() {
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

    /// With the caret outside every page (the browser's address field), a page of an excluded
    /// website elsewhere in the window still refuses the window; a page not excluded gives the host.
    @Test func aWindowIsRefusedForAPageTheCaretIsNotIn() {
        let address = FakeElement("AXTextField", Self.caret)
        let window = FakeElement("AXWindow", [kAXTitleAttribute: "Vault"], children: [address, page("vault.example.com", "account 1234")])
        #expect(!gather(window, focused: address, focusPath: [window], excluding: ["example.com"]).read)
        #expect(!gather(window, focused: nil, focusPath: [], excluding: ["example.com"]).read)

        let read = gather(window, focused: address, focusPath: [window], excluding: ["example.org"])
        #expect(read.read)
        #expect(read.context.host == "vault.example.com")
        #expect(read.context.renderedText() == "» account 1234 ‸balance‸ 99\naccount 1234")
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

    /// A terminal's caret comes from tmux when tmux has the pane; otherwise the terminal's field is
    /// read around the caret and its visible lines kept as a plain field.
    @Test func aTerminalsCaretComesFromItsPaneWhenThereIsOne() {
        let terminal = FakeElement("AXTextArea", Self.caret.merging([kAXValueAttribute: "$ ls"]) { $1 })
        let window = FakeElement("AXWindow", children: [terminal])
        let pane = gather(window, focused: terminal, focusPath: [window], excluding: []) { context in
            context.textBeforeCaret = "$ "
            return true
        }
        #expect(pane.read && pane.asked.caret == 0)
        #expect(pane.context.renderedText() == "» $ ‸")

        let none = gather(window, focused: terminal, focusPath: [window], excluding: []) { _ in false }
        #expect(none.read && none.asked.caret == 1)
        #expect(none.context.textBeforeCaret == "account 1234 ")
        #expect(none.context.renderedText() == "> $ ls")
    }

    /// The focused field read for correction learning: in a page of an excluded website, or that
    /// page itself, its text is never asked for.
    @Test func theFocusedFieldOfAnExcludedWebsiteIsNotRead() {
        let field = FakeElement("AXTextField", [kAXValueAttribute: "account 1234"])
        let area = FakeElement("AXWebArea", ["host": "vault.example.com", kAXValueAttribute: "page text"], children: [field])
        let window = FakeElement("AXWindow", children: [area])
        func value(of element: FakeElement, above path: [FakeElement], excluding hosts: [String]) -> (value: String?, asked: Int) {
            let tree = RecordingTree()
            let value = FocusedField.value(of: element, above: path, in: tree, maxLength: 100, excluding: ScreenExclusions(hosts: hosts))
            return (value, tree.asked.texts)
        }
        #expect(value(of: field, above: [area, window], excluding: ["example.com"]) == (nil, 0))
        #expect(value(of: area, above: [window], excluding: ["example.com"]) == (nil, 0))
        #expect(value(of: field, above: [area, window], excluding: ["example.org"]).value == "account 1234")
        #expect(value(of: area, above: [window], excluding: ["example.org"]).value == "page text")
        // A password field is still never read, and nothing past the limit.
        let password = FakeElement("AXTextField", [kAXSubroleAttribute: kAXSecureTextFieldSubrole, kAXValueAttribute: "hunter2"])
        #expect(value(of: password, above: [window], excluding: []).value == nil)
        #expect(FocusedField.value(of: field, above: [area, window], in: FakeScreenTree(), maxLength: 5, excluding: ScreenExclusions(hosts: [])) == nil)
    }

    /// The helper replies with nothing when the reader refuses, and drops a context on an excluded
    /// host whatever the reader did.
    @Test func aScreenOnAnExcludedWebsiteNeverLeavesTheHelper() async throws {
        let excluding = #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":["example.org","Example.com"]}}"#
        let (refused, refusedReads) = try await replies(to: [excluding], refuses: true)
        #expect(refused.count == 1)
        #expect(refused.first?["result"] is NSNull && refused.first?["error"] == nil)
        #expect(refusedReads.exclusions.withLock { $0 } == [ScreenExclusions(hosts: ["example.org", "Example.com"])])

        let (dropped, _) = try await replies(to: [excluding], host: "vault.example.com")
        #expect(dropped.count == 1)
        #expect(dropped.first?["result"] is NSNull && dropped.first?["error"] == nil)

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
