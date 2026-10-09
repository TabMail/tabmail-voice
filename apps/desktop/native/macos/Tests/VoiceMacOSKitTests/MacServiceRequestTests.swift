// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// A request whose number is no whole number in range (a fraction, 1e100) is refused with an
/// error, not converted: a trapping conversion would crash the helper, and with it the dictation.
@MainActor
struct MacServiceRequestTests {
    @Test func theAcquiredKeyboardLanguageReachesTheReplyUnchanged() async throws {
        let before = KeyboardLanguage.current()
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(on: channel)
        await channel.handle(line: Data(#"{"id":9,"method":"keyboardLanguage","params":{}}"#.utf8))
        #expect(KeyboardLanguage.current() == before)

        let replies = lines.withLock { $0 }
        #expect(replies.count == 1)
        let data = try #require(replies.first)
        let reply = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(reply["id"] as? Int == 9)
        #expect(reply["error"] == nil)
        let result = try #require(reply["result"] as? [String: Any])
        if let before {
            #expect(result["code"] as? String == before)
        } else {
            #expect(result["code"] is NSNull)
        }
        withExtendedLifetime(service) {}
    }

    @Test func documentRedactionUsesTheSharedEngineAndRefusesInvalidInput() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(on: channel)
        await channel.handle(line: Data(#"{"id":1,"method":"redactText","params":{"text":"token=syntheticPrivate123"}}"#.utf8))
        await channel.handle(line: Data(#"{"id":2,"method":"redactText","params":{"text":null}}"#.utf8))
        let oversized: JSON = .object(["id": .number(3), "method": .string("redactText"), "params": .object(["text": .string(String(repeating: "😀", count: 32769))])])
        await channel.handle(line: try JSONEncoder().encode(oversized))
        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == 3)
        #expect(replies.first?["result"] as? NSDictionary == ["text": "token=[redacted]"])
        #expect(replies.dropFirst().allSatisfy { $0["error"] != nil && $0["result"] == nil })
        withExtendedLifetime(service) {}
    }

    @Test func documentRedactionRecognizesASecretContinuingPastAnEdge() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(on: channel)
        for (id, before, text, after, expected) in [
            (1, "token=", "syntheticPrivate123. Public.", "", "[redacted] Public."),
            (2, "", "Public. token=synthetic", "Private123 later.", "Public. token=[redacted]"),
            (3, "Earlier.", "会議は金曜日です。", "次のページ", "会議は金曜日です。")
        ] {
            let params: JSON = .object(["before": .string(before), "text": .string(text), "after": .string(after)])
            let request: JSON = .object(["id": .number(Double(id)), "method": .string("redactText"), "params": params])
            await channel.handle(line: try JSONEncoder().encode(request))
            let line = try #require(lines.withLock { $0.last })
            let reply = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            #expect(reply["result"] as? NSDictionary == ["text": expected])
        }
        #expect(lines.withLock { $0.count } == 3)
        withExtendedLifetime(service) {}
    }

    @Test func aMalformedNumberIsRefusedNotTrappedOn() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let pasted = OSAllocatedUnfairLock<[String]>(initialState: [])
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
            paste: { text in pasted.withLock { $0.append(text) } })
        let requests = [
            #"{"id":3,"method":"caretAnchor","params":{"pid":1e100}}"#,
            #"{"id":4,"method":"globeUpdate","params":{"value":1e100}}"#,
            #"{"id":5,"method":"insert","params":{"text":1e300}}"#,
            #"{"id":9,"method":"insert","params":{"text":""}}"#,
            #"{"id":10,"method":"insert","params":{"text":"a\u0000b"}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
        // A refused paste never reaches the pasteboard or ⌘V.
        #expect(pasted.withLock { $0 }.isEmpty)
        withExtendedLifetime(service) {}
    }

    /// The paste the shared core accepts reaches the pasteboard as sent.
    @Test func anAcceptedPasteIsPastedAsSent() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let pasted = OSAllocatedUnfairLock<[String]>(initialState: [])
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
            paste: { text in pasted.withLock { $0.append(text) } })
        await channel.handle(line: Data(#"{"id":1,"method":"insert","params":{"text":"Dictated 😀 text"}}"#.utf8))
        let line = try #require(lines.withLock { $0.first })
        let reply = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
        #expect(reply["result"] as? NSDictionary == [:])
        #expect(pasted.withLock { $0 } == ["Dictated 😀 text"])
        withExtendedLifetime(service) {}
    }

    /// The screen is read only by `voice-screen-reader` and the focused field only by
    /// `voice-field-reader`, and neither program does anything else: a read stuck in an app's
    /// Accessibility replies never shares a process with a paste.
    @Test func theScreenAndTheFieldAreReadOnlyByTheirReadersWhichDoNothingElse() async throws {
        func replies(_ register: (HelperChannel) -> Void, _ requests: [String]) async throws -> [[String: Any]] {
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            register(channel)
            for request in requests { await channel.handle(line: Data(request.utf8)) }
            return try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        }
        let read = #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[]}}"#
        let field = #"{"id":2,"method":"focusedFieldValue","params":{"pid":8,"maxLength":100,"excludedAppIDs":[],"excludedHosts":[]}}"#
        var service: AnyObject?
        let main = try await replies({ service = MacService.register(on: $0) }, [read, field])
        #expect(main.count == 2)
        guard main.count == 2 else { return }
        #expect((main[0]["error"] as? [String: Any])?["message"] as? String == "unknown method readScreen")
        #expect((main[1]["error"] as? [String: Any])?["message"] as? String == "unknown method focusedFieldValue")
        withExtendedLifetime(service) {}

        let shown = "Dear Xyvora"
        let screen = ScreenAccess(frontmost: { (8, "Notes", "org.example.notes") }, bundleIdentifier: { _ in "org.example.notes" },
                                  read: { _, _, _, _ in nil }, focusedField: { _, _ in .text(shown) })
        let others = ["caretAnchor", "insert", "keyboardLanguage", "startActivator"]
        let request = { (offset: Int, method: String) in #"{"id":\#(offset),"method":"\#(method)","params":{}}"# }
        let screenReader = try await replies({ ScreenReaderService.register(on: $0, screen: screen) },
                                             [read, field] + (others + ["frontmostApp"]).enumerated().map { request($0.offset + 3, $0.element) })
        #expect(screenReader.count == others.count + 3)
        guard screenReader.count == others.count + 3 else { return }
        #expect(screenReader[0]["error"] == nil && screenReader[0]["result"] != nil)
        for (index, method) in (["focusedFieldValue"] + others + ["frontmostApp"]).enumerated() {
            #expect((screenReader[index + 1]["error"] as? [String: Any])?["message"] as? String == "unknown method \(method)")
        }

        // The field reader reads the app it is named (the paste's own, as `voice-macos` named it at
        // key-down) and does not say which app is in front.
        let fieldReader = try await replies({ FieldReaderService.register(on: $0, screen: screen) },
                                            [field, read] + (others + ["frontmostApp"]).enumerated().map { request($0.offset + 3, $0.element) })
        #expect(fieldReader.count == others.count + 3)
        guard fieldReader.count == others.count + 3 else { return }
        #expect(fieldReader[0]["result"] as? NSDictionary == ["value": shown])
        for (index, method) in (["readScreen"] + others + ["frontmostApp"]).enumerated() {
            #expect((fieldReader[index + 1]["error"] as? [String: Any])?["message"] as? String == "unknown method \(method)")
        }
    }

    /// A field read the reader can't carry out is refused, never trapped on.
    @Test func theFieldReaderRefusesAMalformedRequest() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        FieldReaderService.register(on: channel, screen: ScreenAccess(frontmost: { nil }, bundleIdentifier: { _ in nil },
                                                                      read: { _, _, _, _ in nil }, focusedField: { _, _ in .text("x") }))
        let requests = [
            #"{"id":1,"method":"focusedFieldValue","params":{"pid":1e100,"maxLength":10,"excludedAppIDs":[],"excludedHosts":[]}}"#,
            #"{"id":2,"method":"focusedFieldValue","params":{"pid":1,"maxLength":-1,"excludedAppIDs":[],"excludedHosts":[]}}"#,
            #"{"id":3,"method":"focusedFieldValue","params":{"pid":1}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }
        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
    }
}
