// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
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
        let pasteboard = Self.pasteboard()
        defer { pasteboard.releaseGlobally() }
        let before = pasteboard.changeCount
        let keys = OSAllocatedUnfairLock(initialState: 0)
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
            clipboard: ClipboardKeeper(pasteboard: pasteboard), pasteKeystroke: { keys.withLock { $0 += 1 } })
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
        #expect(pasteboard.changeCount == before)
        #expect(keys.withLock { $0 } == 0)
        withExtendedLifetime(service) {}
    }

    /// The paste the shared core accepts reaches the pasteboard as sent, for ⌘V.
    @Test func anAcceptedPasteIsPastedAsSent() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let pasteboard = Self.pasteboard()
        defer { pasteboard.releaseGlobally() }
        let pasted = OSAllocatedUnfairLock<[String?]>(initialState: [])
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
            clipboard: ClipboardKeeper(pasteboard: pasteboard), pasteKeystroke: { let text = pasteboard.string(forType: .string); pasted.withLock { $0.append(text) } })
        await channel.handle(line: Data(#"{"id":1,"method":"insert","params":{"text":"Dictated 😀 text"}}"#.utf8))
        let line = try #require(lines.withLock { $0.first })
        let reply = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
        #expect(reply["result"] as? NSDictionary == [:])
        #expect(pasted.withLock { $0 } == ["Dictated 😀 text"])
        withExtendedLifetime(service) {}
    }

    /// `clipboardSave` answers at once and saves the clipboard for the next `insert`, which puts every
    /// type of it back after the paste keys; one copied after the save is not put back over.
    @Test func theSavedClipboardGoesBackAfterTheNextPaste() async throws {
        let custom = NSPasteboard.PasteboardType("ai.tabmail.test.custom")
        for copiedAfterTheSave in [false, true] {
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            let pasteboard = Self.pasteboard()
            defer { pasteboard.releaseGlobally() }
            let item = NSPasteboardItem()
            item.setString("User text", forType: .string)
            item.setData(Data([1, 2, 3]), forType: custom)
            pasteboard.writeObjects([item])
            let clipboard = ClipboardKeeper(pasteboard: pasteboard, delay: { _ in })
            let pasted = OSAllocatedUnfairLock<[String?]>(initialState: [])
            let service = MacService.register(
                on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
                contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
                clipboard: clipboard, pasteKeystroke: { let text = pasteboard.string(forType: .string); pasted.withLock { $0.append(text) } })
            await channel.handle(line: Data(#"{"id":1,"method":"clipboardSave","params":{}}"#.utf8))
            await clipboard.saveTask?.value
            if copiedAfterTheSave {
                pasteboard.clearContents()
                pasteboard.setString("Newer text", forType: .string)
            }
            await channel.handle(line: Data(#"{"id":2,"method":"insert","params":{"text":"Dictated text"}}"#.utf8))
            await clipboard.restoreTask?.value
            let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
            #expect(replies.map { $0["result"] as? NSDictionary } == [[:], [:]])
            #expect(pasted.withLock { $0 } == ["Dictated text"])
            if copiedAfterTheSave {
                #expect(pasteboard.string(forType: .string) == "Dictated text")
            } else {
                #expect(pasteboard.string(forType: .string) == "User text")
                #expect(pasteboard.data(forType: custom) == Data([1, 2, 3]))
            }
            withExtendedLifetime(service) {}
        }
    }

    /// As the app closes the helper's input, a paste's text no app read is written in full, whether
    /// the wait for its read is still on or has run out with nothing saved to put back.
    @Test(arguments: [false, true]) func anUnreadPasteIsKeptAsTheHelperEnds(waitedOut: Bool) async throws {
        let channel = HelperChannel(output: { _ in })
        let pasteboard = Self.pasteboard()
        defer { pasteboard.releaseGlobally() }
        let clipboard = ClipboardKeeper(pasteboard: pasteboard, rules: .init(readWait: 200, restoreDelay: 20, maxBytes: 1024, maxFormats: 8))
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
            clipboard: clipboard, pasteKeystroke: {})
        await channel.handle(line: Data(#"{"id":1,"method":"insert","params":{"text":"Dictated text"}}"#.utf8))
        if waitedOut { await clipboard.restoreTask?.value }
        let pasted = pasteboard.changeCount
        let input = Pipe()
        await withCheckedContinuation { (exited: CheckedContinuation<Void, Never>) in
            channel.start(input: input.fileHandleForReading, exit: { exited.resume() })
            try? input.fileHandleForWriting.close()
        }
        #expect(pasteboard.changeCount == pasted + 1)
        #expect(pasteboard.string(forType: .string) == "Dictated text")
        #expect(clipboard.offered.withLock { $0 }?.text.wasRead == false)
        await clipboard.restoreTask?.value
        withExtendedLifetime(service) {}
    }

    /// A private, uniquely named pasteboard: tests never touch the user's clipboard.
    private static func pasteboard() -> NSPasteboard {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("ai.tabmail.voice.tests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        return pasteboard
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
        let screen = ScreenAccess(frontmost: { (8, "Notes", "org.example.notes") }, bundleIdentifier: { _ in "org.example.notes" }, window: { _ in nil },
                                  read: { _, _, _, _, _, _, _ in nil }, focusedField: { _, _ in .text(shown) })
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

    /// `readScreenStop` asks the read it names, and every read numbered before it, to stop; a read
    /// numbered after it, or with no number, is never asked. A read number the shared core refuses
    /// (not a whole number from 1) refuses the request.
    @Test func aStopAsksTheReadsNumberedUpToItAndNoLaterOne() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let asked = OSAllocatedUnfairLock<[Bool]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let screen = ScreenAccess(frontmost: { (8, "Notes", "org.example.notes") }, bundleIdentifier: { _ in "org.example.notes" }, window: { _ in nil },
                                  read: { _, _, _, _, _, _, stop in let now = stop(); asked.withLock { $0.append(now) }; return nil }, focusedField: { _, _ in nil })
        ScreenReaderService.register(on: channel, screen: screen)
        let read = { (id: Int, number: String?) in
            #"{"id":\#(id),"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[]\#(number.map { ",\"read\":\($0)" } ?? "")}}"#
        }
        let requests = [
            read(1, "1"),
            #"{"id":2,"method":"readScreenStop","params":{"read":2}}"#,
            read(3, "1"), read(4, "2"), read(5, "3"), read(6, nil),
            #"{"id":7,"method":"readScreenStop","params":{"read":1}}"#,
            read(8, "3"),
            read(9, "0"), read(10, "1.5"), read(11, "\"2\""),
            #"{"id":12,"method":"readScreenStop","params":{}}"#,
            #"{"id":13,"method":"readScreenStop","params":{"read":-4}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }
        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        guard replies.count == requests.count else { return }
        // A later, lower stop does not lower what was asked; read 3 still goes on.
        #expect(asked.withLock { $0 } == [false, true, true, false, false, false])
        #expect(replies[1]["error"] == nil && replies[1]["result"] is NSNull)
        #expect(replies[6]["error"] == nil && replies[6]["result"] is NSNull)
        #expect(replies[8...].allSatisfy { $0["error"] != nil && $0["result"] == nil })
    }

    /// `readScreen`'s `wholeWindow` reaches the read as sent, false when absent; one that is not true
    /// or false refuses the request, and nothing is read.
    @Test func aReadTakesTheWholeWindowOnlyWhenAsked() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let scopes = OSAllocatedUnfairLock<[Bool]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let screen = ScreenAccess(frontmost: { (8, "Notes", "org.example.notes") }, bundleIdentifier: { _ in "org.example.notes" }, window: { _ in nil },
                                  read: { _, _, _, _, _, whole, _ in scopes.withLock { $0.append(whole) }; return nil }, focusedField: { _, _ in nil })
        ScreenReaderService.register(on: channel, screen: screen)
        let requests = [",\"wholeWindow\":true", "", ",\"wholeWindow\":false", ",\"wholeWindow\":\"yes\"", ",\"wholeWindow\":1"].enumerated().map { id, whole in
            #"{"id":\#(id),"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[],"read":1\#(whole)}}"#
        }
        for request in requests { await channel.handle(line: Data(request.utf8)) }
        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        guard replies.count == requests.count else { return }
        #expect(scopes.withLock { $0 } == [true, false, false])
        #expect(replies[..<3].allSatisfy { $0["error"] == nil })
        #expect(replies[3...].allSatisfy { $0["error"] != nil && $0["result"] == nil })
    }

    /// A read of the whole window bound to an earlier read (`sameWindowAs`) reads only the window that
    /// read read, while it is still the one in front, and only when that was the last read; else
    /// the answer is null and nothing is read: another window of the app, or another app, that came
    /// to the front meanwhile is never read in its place.
    @Test func aBoundReadReadsOnlyTheWindowItsReadRead() async throws {
        struct Front: @unchecked Sendable { var pid: pid_t; var window: AXUIElement }
        struct Windows: @unchecked Sendable { let first = AXUIElementCreateApplication(101), second = AXUIElementCreateApplication(102) }
        let windows = Windows()
        let front = OSAllocatedUnfairLock<Front>(uncheckedState: Front(pid: 8, window: windows.first))
        let reads = OSAllocatedUnfairLock<[String]>(initialState: [])
        let lookups = OSAllocatedUnfairLock<[pid_t]>(initialState: [])
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let screen = ScreenAccess(
            frontmost: { (front.withLockUnchecked { $0.pid }, "Notes", "org.example.notes") }, bundleIdentifier: { _ in "org.example.notes" },
            window: { pid in lookups.withLock { $0.append(pid) }; return front.withLockUnchecked { $0.window } },
            read: { pid, _, _, window, _, whole, _ in
                let name = window.map { CFEqual($0, windows.first) ? "first" : "second" } ?? "none"
                reads.withLock { $0.append("\(pid) \(name) \(whole ? "whole" : "shown")") }
                return nil
            }, focusedField: { _, _ in nil })
        ScreenReaderService.register(on: channel, screen: screen)
        func send(_ id: Int, _ params: String) async {
            await channel.handle(line: Data(#"{"id":\#(id),"method":"readScreen","params":{"excludedAppIDs":[],"excludedHosts":[],\#(params)}}"#.utf8))
        }
        // Bound before any read: nothing to follow.
        await send(1, #""read":1,"wholeWindow":true,"sameWindowAs":1"#)
        // The window still in front: read.
        await send(2, #""read":2"#)
        await send(3, #""read":3,"wholeWindow":true,"sameWindowAs":2"#)
        // Bound to a read that is no longer the last one.
        await send(4, #""read":4,"wholeWindow":true,"sameWindowAs":2"#)
        // Another window of the same app came to the front.
        await send(5, #""read":5"#)
        front.withLockUnchecked { $0.window = windows.second }
        await send(6, #""read":6,"wholeWindow":true,"sameWindowAs":5"#)
        // Another app came to the front: its window is not even looked up.
        await send(7, #""read":7"#)
        front.withLockUnchecked { $0.pid = 9 }
        await send(8, #""read":8,"wholeWindow":true,"sameWindowAs":7"#)
        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == 8)
        guard replies.count == 8 else { return }
        let answered = replies.map { reply -> String in
            reply["error"] != nil ? "error" : reply["result"] is NSNull ? "null" : "read"
        }
        #expect(answered == ["null", "read", "read", "null", "read", "null", "read", "null"])
        #expect(reads.withLock { $0 } == ["8 first shown", "8 first whole", "8 first shown", "8 second shown"])
        #expect(lookups.withLock { $0 } == [8, 8, 8, 8, 8])
    }

    @Test func aCapturedWindowIsReadWhileVoiceOrAnotherWindowIsInFront() async throws {
        let fixture = TargetWindowsTests.Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let target = targets.capture()
        fixture.front = 303
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let reads = OSAllocatedUnfairLock<[pid_t]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let screen = ScreenAccess(frontmost: { (303, "Voice", nil) }, bundleIdentifier: { _ in nil }, window: { _ in nil },
            read: { pid, _, _, _, _, _, _ in reads.withLock { $0.append(pid) }; return ScreenContext(appName: "Synthetic app", bundleID: nil) },
            focusedField: { _, _ in nil })
        ScreenReaderService.register(on: channel, screen: screen, targets: targets)
        for (id, whole) in [(1, false), (2, true)] {
            var params: [String: JSON] = ["target": target, "read": .number(Double(id)), "wholeWindow": .bool(whole), "excludedAppIDs": [], "excludedHosts": []]
            if whole { params["sameWindowAs"] = .number(1) }
            let request: JSON = ["id": .number(Double(id)), "method": .string("readScreen"), "params": .object(params)]
            await channel.handle(line: try JSONEncoder().encode(request))
            fixture.front = 202; fixture.focused = fixture.second
        }
        #expect(reads.withLock { $0 } == [101, 101])
        #expect(lines.withLock { $0.count } == 2)
    }

    /// A field read the reader can't carry out is refused, never trapped on.
    @Test func theFieldReaderRefusesAMalformedRequest() async throws {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        FieldReaderService.register(on: channel, screen: ScreenAccess(frontmost: { nil }, bundleIdentifier: { _ in nil }, window: { _ in nil },
                                                                      read: { _, _, _, _, _, _, _ in nil }, focusedField: { _, _ in .text("x") }))
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
