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
        let service = MacService.register(on: channel)
        let requests = [
            #"{"id":3,"method":"caretAnchor","params":{"pid":1e100}}"#,
            #"{"id":4,"method":"globeUpdate","params":{"value":1e100}}"#,
            #"{"id":5,"method":"insert","params":{"text":"x","restoreDelay":1e300}}"#,
            #"{"id":6,"method":"focusedFieldValue","params":{"pid":1e100,"maxLength":10}}"#,
            #"{"id":7,"method":"focusedFieldValue","params":{"pid":1,"maxLength":-1}}"#,
            #"{"id":8,"method":"focusedFieldValue","params":{"pid":1}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        #expect(replies.allSatisfy { $0["error"] != nil && $0["result"] == nil })
        withExtendedLifetime(service) {}
    }

    /// The screen is read only by `voice-screen-reader`, and that program does nothing else:
    /// a read stuck in an app's Accessibility replies never shares a process with a paste.
    @Test func theScreenIsReadOnlyByTheReaderAndTheReaderDoesNothingElse() async throws {
        func replies(_ register: (HelperChannel) -> Void, _ requests: [String]) async throws -> [[String: Any]] {
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            register(channel)
            for request in requests { await channel.handle(line: Data(request.utf8)) }
            return try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        }
        let read = #"{"id":1,"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[]}}"#
        var service: AnyObject?
        let main = try await replies({ service = MacService.register(on: $0) }, [read])
        #expect((main.first?["error"] as? [String: Any])?["message"] as? String == "unknown method readScreen")
        withExtendedLifetime(service) {}

        let nothing = ScreenAccess(frontmost: { nil }, bundleIdentifier: { _ in nil }, read: { _, _, _, _ in nil }, focusedField: { _, _, _ in nil })
        let others = ["frontmostApp", "caretAnchor", "focusedFieldValue", "insert", "keyboardLanguage", "startActivator"]
        let reader = try await replies({ ScreenReaderService.register(on: $0, screen: nothing) },
                                       [read] + others.enumerated().map { #"{"id":\#($0.offset + 2),"method":"\#($0.element)","params":{}}"# })
        #expect(reader.count == others.count + 1)
        guard reader.count == others.count + 1 else { return }
        #expect(reader[0]["error"] == nil && reader[0]["result"] is NSNull)
        for (index, method) in others.enumerated() {
            #expect((reader[index + 1]["error"] as? [String: Any])?["message"] as? String == "unknown method \(method)")
        }
    }
}
