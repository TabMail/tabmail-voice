// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import Testing
@testable import VoiceMacOSKit

/// One app's fields as `InsertionTarget` sees them: which has focus, and each one's caret, which the
/// user moves between the capture and the paste. A field may refuse focus or a caret put back, or,
/// as Chromium does, apply a set only after `lag` more reads.
private final class FakeApp: TextFieldAccess {
    let pid: pid_t = 42
    var focused: Int?
    var carets: [Int: Int] = [:]
    var refusesFocus: Set<Int> = []
    var refusesCaret: Set<Int> = []
    private(set) var focusRequests: [Int] = []
    private(set) var caretRequests: [Int] = []
    var lag = 0
    private var pending: [() -> Void] = []
    private var readsBeforeApplied = 0

    private func apply(_ set: @escaping () -> Void) {
        guard lag > 0 else { return set() }
        pending.append(set)
        readsBeforeApplied = lag
    }

    private func read() {
        guard !pending.isEmpty else { return }
        if readsBeforeApplied > 0 { readsBeforeApplied -= 1; return }
        pending.forEach { $0() }
        pending = []
    }

    func focusedElement(inApp pid: pid_t) -> Int? {
        read()
        return pid == self.pid ? focused : nil
    }
    func isSame(_ first: Int, _ second: Int) -> Bool { first == second }
    func focus(_ element: Int) {
        focusRequests.append(element)
        if !refusesFocus.contains(element) { apply { self.focused = element } }
    }
    func selection(of element: Int) -> Int? {
        read()
        return carets[element]
    }
    func select(_ selection: Int, in element: Int) {
        caretRequests.append(selection)
        if !refusesCaret.contains(element) { apply { self.carets[element] = selection } }
    }
    func isSame(_ first: Int, _ second: Int, in element: Int) -> Bool { first == second }
}

struct InsertionTargetTests {
    /// Field 1 focused, its caret at 10: captured so.
    private func captured() -> (FakeApp, InsertionTarget<FakeApp>) {
        let app = FakeApp()
        app.focused = 1
        app.carets = [1: 10, 2: 0]
        return (app, .capture(inApp: app.pid, access: app))
    }

    @Test func nothingMovedPastesInPlaceTouchingNothing() {
        let (app, target) = captured()
        #expect(target.restore(frontmost: app.pid, access: app) == .inPlace)
        #expect(app.focusRequests.isEmpty)
        #expect(app.caretRequests.isEmpty)
    }

    /// The bug: the user clicked elsewhere in the same field while the text was transcribed.
    @Test func aCaretMovedInTheFieldGoesBack() {
        let (app, target) = captured()
        app.carets[1] = 3
        #expect(target.restore(frontmost: app.pid, access: app) == .inPlace)
        #expect(app.carets[1] == 10)
        #expect(app.focusRequests.isEmpty)
    }

    @Test func focusInAnotherFieldOfTheAppGoesBackWithTheCaret() {
        let (app, target) = captured()
        app.focused = 2
        app.carets[1] = 0
        #expect(target.restore(frontmost: app.pid, access: app) == .inPlace)
        #expect(app.focused == 1)
        #expect(app.carets[1] == 10)
    }

    @Test func anotherAppInFrontPastesNothingAndTouchesNothing() {
        let (app, target) = captured()
        #expect(target.restore(frontmost: app.pid + 1, access: app) == .appChanged)
        #expect(target.restore(frontmost: nil, access: app) == .appChanged)
        #expect(app.focusRequests.isEmpty)
        #expect(app.caretRequests.isEmpty)
    }

    /// Chromium applies a focus or selection set after answering the next reads from its cached tree:
    /// the restore waits for the set to show rather than refusing the paste at once.
    @Test func aFocusAndCaretPutBackLateStillPasteInPlace() {
        let (app, target) = captured()
        app.focused = 2
        app.carets[1] = 3
        app.lag = 3
        #expect(target.restore(frontmost: app.pid, access: app, settle: 5, poll: 0.001) == .inPlace)
        #expect(app.focused == 1)
        #expect(app.carets[1] == 10)
    }

    @Test func aCaretThatDoesntShowWithinTheSettleTimePastesNothing() {
        let (app, target) = captured()
        app.carets[1] = 3
        app.lag = .max
        #expect(target.restore(frontmost: app.pid, access: app, settle: 0.02, poll: 0.001) == .caretMoved)
    }

    @Test func aFieldThatWontTakeFocusBackPastesNothing() {
        let (app, target) = captured()
        app.focused = 2
        app.refusesFocus = [1]
        #expect(target.restore(frontmost: app.pid, access: app) == .caretMoved)
        #expect(app.caretRequests.isEmpty)
    }

    @Test func aCaretThatWontGoBackPastesNothing() {
        let (app, target) = captured()
        app.carets[1] = 3
        app.refusesCaret = [1]
        #expect(target.restore(frontmost: app.pid, access: app) == .caretMoved)
    }

    /// The field no longer answers for its caret (it was emptied or closed): it can't be put back.
    @Test func aFieldThatLostItsCaretPastesNothing() {
        let (app, target) = captured()
        app.carets[1] = nil
        app.refusesCaret = [1]
        #expect(target.restore(frontmost: app.pid, access: app) == .caretMoved)
    }

    /// An app that shows no focused field at key-down: nothing is known of the caret, so the paste
    /// goes where focus is, in that app only.
    @Test func withoutAFieldAtKeyDownOnlyTheAppIsChecked() {
        let app = FakeApp()
        let target = InsertionTarget<FakeApp>.capture(inApp: app.pid, access: app)
        #expect(target.element == nil)
        app.focused = 2
        #expect(target.restore(frontmost: app.pid, access: app) == .inPlace)
        #expect(target.restore(frontmost: app.pid + 1, access: app) == .appChanged)
        #expect(app.focusRequests.isEmpty)
    }

    /// A field without a caret to read (some custom views): focus alone is put back.
    @Test func withoutACaretAtKeyDownOnlyFocusIsPutBack() {
        let app = FakeApp()
        app.focused = 1
        let target = InsertionTarget<FakeApp>.capture(inApp: app.pid, access: app)
        #expect(target.selection == nil)
        app.focused = 2
        #expect(target.restore(frontmost: app.pid, access: app) == .inPlace)
        #expect(app.focused == 1)
        #expect(app.caretRequests.isEmpty)
    }

    @MainActor
    @Test func aPasteFindsOnlyItsOwnDictationsTarget() {
        let targets = InsertionTargets()
        let target = InsertionTargets.Captured(target: InsertionTarget(pid: 1, element: nil, selection: nil))
        targets.keep(target, session: 3)
        #expect(targets.target(session: 3) != nil)
        #expect(targets.target(session: 2) == nil)
        targets.keep(target, session: 4)
        #expect(targets.target(session: 3) == nil)
    }

    /// Captures run concurrently: an older dictation's finishing last keeps the newer one's target.
    @MainActor
    @Test func anOlderCaptureFinishingLastDoesntReplaceANewerOne() {
        let targets = InsertionTargets()
        let target = InsertionTargets.Captured(target: InsertionTarget(pid: 1, element: nil, selection: nil))
        targets.keep(target, session: 5)
        targets.keep(target, session: 4)
        #expect(targets.target(session: 5) != nil)
        #expect(targets.target(session: 4) == nil)
    }

    @Test func characterRangesAreTheSameOnlyWhenEqual() {
        let access = AXTextFieldAccess()
        let element = AXUIElementCreateApplication(getpid())
        let caret = AXSelection.range(CFRange(location: 4, length: 0))
        #expect(access.isSame(caret, .range(CFRange(location: 4, length: 0)), in: element))
        #expect(!access.isSame(caret, .range(CFRange(location: 4, length: 2)), in: element))
        #expect(!access.isSame(caret, .range(CFRange(location: 5, length: 0)), in: element))
    }

    /// Text markers are opaque: equal ones are the same place; unequal ones are only when the field
    /// puts both at the same bounds, which a field without them (here, this test process) never does;
    /// a marker is never the same as a character range.
    @Test func textMarkersAreTheSameWhenEqual() {
        let access = AXTextFieldAccess()
        let element = AXUIElementCreateApplication(getpid())
        let marker = AXSelection.marker("marker" as CFString)
        #expect(access.isSame(marker, .marker("marker" as CFString), in: element))
        #expect(!access.isSame(marker, .marker("other" as CFString), in: element))
        #expect(!access.isSame(marker, .range(CFRange(location: 0, length: 0)), in: element))
        #expect(!access.isSame(.range(CFRange(location: 0, length: 0)), marker, in: element))
    }
}
