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
