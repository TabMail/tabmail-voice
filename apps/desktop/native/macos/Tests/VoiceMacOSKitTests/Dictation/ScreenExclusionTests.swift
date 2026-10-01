// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// An app the user excludes from screen reading is never read: not its screen as a dictation
/// starts, not its focused field after the paste. Over stand-ins that record what was read; no
/// real app is read.
@MainActor
struct ScreenExclusionTests {
    /// What the stand-ins were asked to read.
    private final class Reads: Sendable {
        let screens = OSAllocatedUnfairLock<[String]>(initialState: [])
        let fields = OSAllocatedUnfairLock<[pid_t]>(initialState: [])
    }

    /// The replies to `requests`, with `frontmost` in front and `apps` running (pid to bundle identifier).
    private func replies(
        to requests: [String], frontmost: (pid_t, String, String?)? = (7, "Example Vault", "org.example.vault"),
        apps: [pid_t: String] = [7: "org.example.vault", 8: "org.example.notes"]
    ) async throws -> (replies: [[String: Any]], reads: Reads) {
        let reads = Reads()
        let screen = ScreenAccess(
            frontmost: { frontmost },
            bundleIdentifier: { apps[$0] },
            read: { pid, name, bundleID in
                reads.screens.withLock { $0.append("\(pid) \(name) \(bundleID ?? "-")") }
                return ["appName": .string(name)]
            },
            focusedField: { pid, _ in
                reads.fields.withLock { $0.append(pid) }
                return "field text"
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
            #"{"id":1,"method":"readScreen","params":{"excludedBundleIdentifiers":["org.example.bank","org.example.vault"]}}"#,
            #"{"id":2,"method":"readScreen","params":{"excludedBundleIdentifiers":["ORG.Example.Vault"]}}"#,
        ])
        #expect(replies.count == 2)
        #expect(replies.allSatisfy { $0["result"] is NSNull && $0["error"] == nil })
        #expect(reads.screens.withLock { $0 }.isEmpty)
    }

    @Test func anAppNotExcludedIsRead() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"readScreen","params":{"excludedBundleIdentifiers":[]}}"#,
            #"{"id":2,"method":"readScreen","params":{"excludedBundleIdentifiers":["org.example.bank","org.example.vault.helper","org.example"]}}"#,
        ])
        #expect(replies.count == 2)
        #expect(replies.allSatisfy { ($0["result"] as? [String: Any])?["appName"] as? String == "Example Vault" })
        #expect(reads.screens.withLock { $0 } == ["7 Example Vault org.example.vault", "7 Example Vault org.example.vault"])
    }

    /// An app without a bundle identifier can't be excluded, and is read; with no app in front
    /// nothing is.
    @Test func anAppWithoutAnIdentifierIsReadAndNoAppIsNot() async throws {
        let request = #"{"id":1,"method":"readScreen","params":{"excludedBundleIdentifiers":["org.example.vault"]}}"#
        let (bare, bareReads) = try await replies(to: [request], frontmost: (9, "Tool", nil))
        #expect((bare.first?["result"] as? [String: Any])?["appName"] as? String == "Tool")
        #expect(bareReads.screens.withLock { $0 } == ["9 Tool -"])

        let (none, noReads) = try await replies(to: [request], frontmost: nil)
        #expect(none.first?["result"] is NSNull)
        #expect(noReads.screens.withLock { $0 }.isEmpty)
    }

    /// A request that doesn't say which apps are excluded is refused, and nothing is read.
    @Test func aRequestWithoutTheExcludedAppsReadsNothing() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"readScreen","params":{}}"#,
            #"{"id":2,"method":"readScreen","params":{"excludedBundleIdentifiers":"org.example.vault"}}"#,
            #"{"id":3,"method":"readScreen","params":{"excludedBundleIdentifiers":["org.example.bank",7]}}"#,
            #"{"id":4,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100}}"#,
            #"{"id":5,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedBundleIdentifiers":[null]}}"#,
        ])
        #expect(replies.count == 5)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
        #expect(reads.screens.withLock { $0 }.isEmpty)
        #expect(reads.fields.withLock { $0 }.isEmpty)
    }

    @Test func theFocusedFieldOfAnExcludedAppIsNotRead() async throws {
        let (replies, reads) = try await replies(to: [
            #"{"id":1,"method":"focusedFieldValue","params":{"pid":7,"maxLength":100,"excludedBundleIdentifiers":["Org.Example.Vault"]}}"#,
            #"{"id":2,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedBundleIdentifiers":["org.example.vault"]}}"#,
            #"{"id":3,"method":"focusedFieldValue","params":{"pid":99,"maxLength":100,"excludedBundleIdentifiers":["org.example.vault"]}}"#,
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
        #expect(Apps.isExcluded("com.example.Vault", by: ["org.example.bank", "COM.EXAMPLE.vault"]))
        #expect(!Apps.isExcluded("com.example.vault", by: []))
        #expect(!Apps.isExcluded("com.example.vault", by: ["com.example", "com.example.vault.helper", "example.vault"]))
        #expect(!Apps.isExcluded(nil, by: ["com.example.vault", ""]))
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
}
