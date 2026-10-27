// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

@Suite @MainActor struct TargetWindowsTests {
    @MainActor final class Fixture {
        let first = AXUIElementCreateApplication(101)
        let second = AXUIElementCreateApplication(202)
        var front: pid_t = 101
        var focused: AXUIElement
        var field: AXUIElement? = AXUIElementCreateApplication(404)
        var living: [AXUIElement]
        var clipboard = 7
        var keys = 0
        var raised = 0
        var allowsRaise = true
        var time = Date().timeIntervalSince1970 * 1000
        var onFocus: () -> Void = {}
        var onFront: () -> Void = {}
        init() { focused = first; living = [first, second] }
        func system() -> TargetWindows.System {
            .init(frontmost: { self.onFront(); return (self.front, "Synthetic app", nil) },
                  focusedWindow: { _ in self.onFocus(); return self.focused }, windows: { _ in self.living },
                  raise: { pid, window in
                    self.raised += 1
                    if self.allowsRaise { self.front = pid; self.focused = window }
                  },
                  clipboardCount: { self.clipboard }, focusedElement: { _ in self.field }, now: { self.time }, post: { self.keys += 1 })
        }
        var deadline: Double { time + 1000 }
    }

    @Test func theLiveFieldLookupReturnsNoElementForAnUnavailableApplication() {
        #expect(TargetWindows.System.live().focusedElement(0) == nil)
    }

    @Test func theConfiguredNativeFieldLookupAcceptsOnlyAnAXElement() throws {
        let field = AXUIElementCreateApplication(404)
        for value: CFTypeRef? in [field, nil, "wrong type" as CFString] {
            var lookedUp = false
            let system = TargetWindows.System.live(attribute: { app, name in
                var pid: pid_t = 0
                #expect(AXUIElementGetPid(app, &pid) == .success)
                #expect(pid == 101)
                #expect(name == kAXFocusedUIElementAttribute)
                lookedUp = true
                return value
            })
            let result = system.focusedElement(101)
            #expect(lookedUp)
            if let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
                #expect(result.map { CFEqual($0, field) } == true)
            } else {
                #expect(result == nil)
            }
        }
    }

    @Test func voiceInFrontKeepsTheExactWindowBeforeIt() throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        fixture.front = 303
        let captured = targets.capture()
        let target = try targets.resolve(captured)
        #expect(target?.pid == 101)
        #expect(target.map { CFEqual($0.window, fixture.first) } == true)
    }

    @Test func anotherExternalWindowAtKeyDownBecomesTheTarget() throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        fixture.front = 202; fixture.focused = fixture.second
        let target = try targets.resolve(targets.capture())
        #expect(target?.pid == 202)
        #expect(target.map { CFEqual($0.window, fixture.second) } == true)
    }

    @Test func aPasteRestoresAndChecksItsExactWindow() async throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        fixture.front = 202; fixture.focused = fixture.second
        try await targets.paste(captured, transaction: 7, deadline: fixture.deadline)
        #expect(fixture.front == 101)
        #expect(CFEqual(fixture.focused, fixture.first))
        #expect(fixture.raised == 1)
        #expect(fixture.keys == 1)
    }

    @Test func theSameAppWithAnotherWindowRestoresTheCapturedWindow() async throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        fixture.focused = fixture.second
        try await targets.paste(captured, transaction: 7, deadline: fixture.deadline)
        #expect(CFEqual(fixture.focused, fixture.first))
        #expect(fixture.raised == 1)
        #expect(fixture.keys == 1)
    }

    @Test func aGoneWindowNeverPostsKeys() async {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        fixture.living = [fixture.second]
        await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.deadline) }
        #expect(fixture.keys == 0)
        #expect(fixture.raised == 0)
    }

    @Test func aNewClipboardOrExpiredPasteNeverPostsKeys() async {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        fixture.clipboard += 1
        await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.deadline) }
        fixture.clipboard = 7
        await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.time - 1) }
        #expect(fixture.keys == 0)
    }

    @Test func cancellationVetoesTheKeysAndCannotCancelTheNextTarget() async throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let first = targets.capture()
        try targets.cancel(first)
        await #expect(throws: (any Error).self) { try await targets.paste(first, transaction: 7, deadline: fixture.deadline) }
        #expect(fixture.keys == 0)
        let second = targets.capture()
        try targets.cancel(first)
        try await targets.paste(second, transaction: 7, deadline: fixture.deadline)
        #expect(fixture.keys == 1)
    }

    @Test func cancellationDuringActivationPreventsKeyDownAfterTheNativeLookupReturns() async throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        fixture.front = 202; fixture.focused = fixture.second
        fixture.onFocus = {
            if fixture.raised > 0 { try? targets.cancel(captured); fixture.onFocus = {} }
        }
        await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.deadline) }
        #expect(fixture.raised == 1)
        #expect(fixture.keys == 0)
    }

    @Test func expiryDuringActivationPreventsKeyDownAfterTheNativeLookupReturns() async throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        let deadline = fixture.deadline
        fixture.front = 202; fixture.focused = fixture.second
        fixture.onFocus = {
            if fixture.raised > 0 { fixture.time = deadline + 1; fixture.onFocus = {} }
        }
        await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: deadline) }
        #expect(fixture.raised == 1)
        #expect(fixture.keys == 0)
    }

    @Test func delayedActivationSucceedsOnceAndRefusalNeverPosts() async throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        fixture.front = 202; fixture.focused = fixture.second; fixture.allowsRaise = false
        // OS activation completes independently of this helper's actor. Other native suites may
        // deliberately occupy that actor; their work must not postpone the simulated OS event.
        let activation = OSAllocatedUnfairLock(initialState: false)
        fixture.onFront = {
            if activation.withLock({ $0 }) { fixture.front = 101; fixture.focused = fixture.first }
        }
        let activated = Task.detached {
            try await Task.sleep(for: .milliseconds(40))
            activation.withLock { $0 = true }
        }
        try await targets.paste(captured, transaction: 7, deadline: fixture.deadline)
        try await activated.value
        fixture.onFront = {}
        #expect(fixture.keys == 1)
        let next = targets.capture()
        fixture.front = 202; fixture.focused = fixture.second
        await #expect(throws: (any Error).self) { try await targets.paste(next, transaction: 7, deadline: fixture.deadline) }
        #expect(fixture.keys == 1)
    }

    @Test func aTargetLostOrSupersededDuringActivationNeverPosts() async throws {
        for superseded in [false, true] {
            let fixture = Fixture()
            let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
            let captured = targets.capture()
            fixture.front = 202; fixture.focused = fixture.second; fixture.allowsRaise = false
            let changed = Task { @MainActor in
                try await Task.sleep(for: .milliseconds(30))
                if superseded { _ = targets.capture() } else { fixture.living = [fixture.second] }
            }
            await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.deadline) }
            try await changed.value
            #expect(fixture.keys == 0)
        }
    }


    @Test func aChangedOrMissingFieldNeverReceivesThePaste() async {
        for missing in [false, true] {
            let fixture = Fixture()
            let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
            let captured = targets.capture()
            fixture.field = missing ? nil : AXUIElementCreateApplication(505)
            await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.deadline) }
            #expect(fixture.keys == 0)
        }
    }

    @Test func aFieldChangedDuringWindowActivationNeverReceivesThePaste() async {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        fixture.front = 202; fixture.focused = fixture.second
        fixture.onFocus = {
            if fixture.raised > 0 { fixture.field = AXUIElementCreateApplication(505) }
        }
        await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.deadline) }
        #expect(fixture.raised == 1)
        #expect(fixture.keys == 0)
    }

    @Test func theSameFieldCanReceiveTextAfterItsContentsChange() async throws {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        // No text or selection snapshot participates in identity. Re-reading the same AX object
        // after typing, layout changes or caret movement must still permit the paste.
        fixture.field = AXUIElementCreateApplication(404)
        try await targets.paste(captured, transaction: 7, deadline: fixture.deadline)
        #expect(fixture.keys == 1)
    }

    @Test func anAppWithoutAnAccessibleFieldStillReceivesItsPaste() async throws {
        let fixture = Fixture()
        fixture.field = nil
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = targets.capture()
        try await targets.paste(captured, transaction: 7, deadline: fixture.deadline)
        #expect(fixture.keys == 1)
    }

    @Test func voiceInFrontPreservesThePreviousFieldsIdentity() async {
        let fixture = Fixture()
        let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        fixture.front = 303
        let captured = targets.capture()
        fixture.field = AXUIElementCreateApplication(505)
        await #expect(throws: (any Error).self) { try await targets.paste(captured, transaction: 7, deadline: fixture.deadline) }
        #expect(fixture.keys == 0)
    }

    @Test func aRestartedReaderNeverResolvesAnOldToken() throws {
        let fixture = Fixture()
        let first = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        let captured = first.capture()
        let second = TargetWindows(system: fixture.system(), owner: 303, observe: false)
        _ = second.capture()
        #expect(try second.resolve(captured) == nil)
    }
    @Test func focusMovedDuringTheFinalWindowLookupDoesNotPasteIntoTheNewField() async throws {
        let fixture = TargetWindowsTests.Fixture()
        let initial = try #require(fixture.field)
        let replacement = AXUIElementCreateApplication(505)
        var lookups = 0
        var armed = false
        var checked = 0
        var posted: [AXUIElement] = []
        var system = fixture.system()
        system.focusedElement = { _ in
            if armed { checked += 1 }
            return fixture.field
        }
        system.post = {
            if let field = fixture.field { posted.append(field) }
            fixture.keys += 1
        }
        let targets = TargetWindows(system: system, owner: 303, observe: false)
        let capture = targets.capture()
        let snapshot = try #require(try targets.resolve(capture))
        #expect(snapshot.field.map { CFEqual($0, initial) } == true)
        fixture.onFocus = {
            lookups += 1
            if lookups == 3 { fixture.field = replacement }
        }
        armed = true
        do { try await targets.paste(capture, transaction: 7, deadline: fixture.deadline) } catch {}
        #expect(checked > 0)
        #expect(lookups == 3)
        #expect(fixture.field.map { CFEqual($0, replacement) } == true)
        #expect(posted.isEmpty)
        #expect(fixture.keys == 0)
    }
    @Test func aVoiceCaptureKeepsItsOriginalFieldAndTheNextExternalActionSelectsItsOwnField() async throws {
        for inaccessibleWhileVoiceIsInFront in [false, true] {
            let fixture = TargetWindowsTests.Fixture()
            let targets = TargetWindows(system: fixture.system(), owner: 303, observe: false)
            let newerField = AXUIElementCreateApplication(505)
            fixture.front = 303
            fixture.field = inaccessibleWhileVoiceIsInFront ? nil : newerField
            let capture = targets.capture()
            fixture.front = 101
            fixture.field = newerField
            await #expect(throws: (any Error).self) {
                try await targets.paste(capture, transaction: 7, deadline: fixture.deadline)
            }
            #expect(fixture.keys == 0)
            let next = targets.capture()
            try await targets.paste(next, transaction: 7, deadline: fixture.deadline)
            #expect(fixture.keys == 1)
        }
    }
}
