// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

@Suite(.serialized) @MainActor struct PreparedClipboardTests {
    @MainActor final class Fixture {
        let board = NSPasteboard(name: .init("ai.tabmail.voice.prepared.\(UUID().uuidString)"))
        let keeper: ClipboardKeeper
        let channel: HelperChannel
        let service: AnyObject
        init() {
            keeper = ClipboardKeeper(pasteboard: board, rules: .init(readWait: 1, restoreDelay: 1, maxBytes: 1024, maxFormats: 8))
            channel = HelperChannel(output: { _ in })
            service = MacService.register(on: channel,
                eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
                contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
                clipboard: keeper, pasteKeystroke: { Issue.record("preparation must post no keys") })
        }
        func save() async {
            board.clearContents(); board.setString("Synthetic prior copy", forType: .string)
            keeper.save(); await keeper.saveTask?.value
        }
        func send(_ method: String, _ params: JSON) async throws {
            let data = try JSONEncoder().encode(["id": JSON.number(1), "method": .string(method), "params": params])
            await channel.handle(line: data)
        }
        func prepare(_ operation: Int, deadline: Double) async throws {
            try await send("preparePaste", ["operation": .number(Double(operation)), "deadline": .number(deadline), "text": .string("Synthetic dictated text")])
        }
        func finish(_ operation: Int) async throws {
            try await send("finishPaste", ["operation": .number(Double(operation))])
            await keeper.restoreTask?.value
        }
        var deadline: Double { floor(Date().timeIntervalSince1970 * 1000) + 1000 }
        func close() { board.releaseGlobally(); withExtendedLifetime(service) {} }
    }

    @Test func preparationAndFinishObserveRealClipboardEffectsWithoutKeys() async throws {
        let fixture = Fixture(); defer { fixture.close() }
        await fixture.save()
        try await fixture.prepare(1, deadline: fixture.deadline)
        #expect(fixture.board.string(forType: .string) == "Synthetic dictated text")
        try await fixture.finish(1)
        #expect(fixture.board.string(forType: .string) == "Synthetic prior copy")
    }

    @Test func anExpiredPreparationCannotOverwriteANewerCopy() async throws {
        let fixture = Fixture(); defer { fixture.close() }
        await fixture.save()
        fixture.board.clearContents(); fixture.board.setString("Synthetic newer copy", forType: .string)
        try await fixture.prepare(1, deadline: floor(Date().timeIntervalSince1970 * 1000) - 1)
        #expect(fixture.board.string(forType: .string) == "Synthetic newer copy")
    }

    @Test func aPreparationIsCleanedUpEvenWhenNoAcknowledgementOrFinishArrives() async throws {
        let fixture = Fixture(); defer { fixture.close() }
        await fixture.save()
        try await fixture.prepare(1, deadline: floor(Date().timeIntervalSince1970 * 1000) + 100)
        #expect(fixture.board.string(forType: .string) == "Synthetic dictated text")
        try await Task.sleep(for: .milliseconds(200))
        await fixture.keeper.restoreTask?.value
        #expect(fixture.board.string(forType: .string) == "Synthetic prior copy")
    }

    @Test func aPreparationQueuedPastItsDeadlineCannotAcquireTheClipboard() async throws {
        let fixture = Fixture(); defer { fixture.close() }
        await fixture.save()
        let preparations = PreparedClipboard(fixture.keeper)
        let deadline = Date().timeIntervalSince1970 * 1000 + 30
        let pending = Task.detached { try await preparations.prepare("Synthetic dictated text", operation: 1, deadline: deadline) }
        // The actor is occupied while an already-valid request queues its native write.
        func occupyActor() { Thread.sleep(forTimeInterval: 0.08) }
        occupyActor()
        fixture.board.clearContents(); fixture.board.setString("Synthetic newer copy", forType: .string)
        await #expect(throws: (any Error).self) { _ = try await pending.value }
        #expect(fixture.board.string(forType: .string) == "Synthetic newer copy")
    }

    @Test func cancellationBeforeQueuedPreparationPreventsItsWrite() async throws {
        let fixture = Fixture(); defer { fixture.close() }
        await fixture.save()
        try await fixture.finish(1)
        try await fixture.prepare(1, deadline: fixture.deadline)
        #expect(fixture.board.string(forType: .string) == "Synthetic prior copy")
    }

    @Test func cleanupPreservesANewerCopyAndANewerOperation() async throws {
        let fixture = Fixture(); defer { fixture.close() }
        await fixture.save()
        try await fixture.prepare(1, deadline: fixture.deadline)
        fixture.board.clearContents(); fixture.board.setString("Synthetic newer copy", forType: .string)
        try await fixture.finish(1)
        #expect(fixture.board.string(forType: .string) == "Synthetic newer copy")
        fixture.keeper.save(); await fixture.keeper.saveTask?.value
        try await fixture.prepare(2, deadline: fixture.deadline)
        try await fixture.finish(1)
        #expect(fixture.board.string(forType: .string) == "Synthetic dictated text")
        try await fixture.finish(2)
        #expect(fixture.board.string(forType: .string) == "Synthetic newer copy")
    }
}
