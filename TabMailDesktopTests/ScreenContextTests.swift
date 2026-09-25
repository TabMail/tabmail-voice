// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import CoreGraphics
import Foundation
import os
import Testing
@testable import TabMail

struct ScreenContextTests {
    // MARK: Caret window

    @Test func caretWindowSplitsAroundTheSelection() {
        let window = ScreenContext.caretWindow(in: "Hello there world", selection: NSRange(location: 6, length: 5), maxChars: 100)
        #expect(window.before == "Hello ")
        #expect(window.selected == "there")
        #expect(window.after == " world")
    }

    @Test func caretWindowKeepsOnlyTheNearestCharacters() {
        let window = ScreenContext.caretWindow(in: "abcdefghij", selection: NSRange(location: 5, length: 0), maxChars: 2)
        #expect(window.before == "de")
        #expect(window.selected == "")
        #expect(window.after == "fg")
    }

    /// Accessibility reports ranges past the end at times (a stale caret); clamp, don't crash.
    @Test func caretWindowClampsARangePastTheEnd() {
        let window = ScreenContext.caretWindow(in: "abc", selection: NSRange(location: 10, length: 4), maxChars: 5)
        #expect(window.before == "abc")
        #expect(window.selected == "")
        #expect(window.after == "")
    }

    /// Ranges count UTF-16 units; a cut through an emoji's surrogate pair keeps the whole emoji.
    @Test func caretWindowNeverSplitsACharacter() {
        let text = "a😀b" // "😀" is two UTF-16 units: a=0, 😀=1…2, b=3
        let window = ScreenContext.caretWindow(in: text, selection: NSRange(location: 3, length: 0), maxChars: 1)
        #expect(window.before == "😀")
        #expect(window.after == "b")
    }

    // MARK: Visible text

    @Test func appendSkipsBlanksAndRepeats() {
        var context = ScreenContext(appName: "Example")
        context.append(.link, "Inbox")
        context.append(.text, "Inbox")
        context.append(.text, "  ")
        context.append(.text, " Drafts\n")
        #expect(context.blocks == [.init(kind: .link, text: "Inbox"), .init(kind: .text, text: "Drafts")])
    }

    @Test func renderedTextMarksStructure() {
        var context = ScreenContext(appName: "Example")
        context.append(.heading, "Results")
        context.append(.row, "Paper | 2024 | 12")
        context.append(.link, "Next page")
        context.append(.field, "line one\nline two")
        context.append(.text, "Plain")
        #expect(context.renderedText() == "## Results\n| Paper | 2024 | 12\n[Next page]\n> line one\n> line two\nPlain")
    }

    /// The focused field sits between the text above and below it, with the caret marked.
    @Test func caretBlockKeepsItsPlaceInTheReadingOrder() {
        var context = ScreenContext(appName: "Example")
        context.textBeforeCaret = "Draft "
        context.textAfterCaret = "reply"
        context.append(.text, "Earlier comment")
        context.appendCaret()
        context.append(.text, "Footer")
        #expect(context.renderedText() == "Earlier comment\n» Draft ‸reply\nFooter")
    }

    @Test func emptyFocusedFieldStillMarksTheCaret() {
        var context = ScreenContext(appName: "Example")
        context.appendCaret()
        #expect(context.renderedText() == "» ‸")
    }

    @Test func selectionIsBracketedByCaretMarkers() {
        var context = ScreenContext(appName: "Example")
        context.textBeforeCaret = "a "
        context.selectedText = "b"
        context.textAfterCaret = " c"
        context.appendCaret()
        #expect(context.renderedText() == "» a ‸b‸ c")
    }

    @Test func summaryCarriesSizesNotText() {
        var context = ScreenContext(appName: "Example", bundleID: "com.example.app")
        context.windowTitle = "Private subject"
        context.textBeforeCaret = "secret words"
        context.append(.text, "confidential paragraph")
        #expect(!context.summary.contains("secret"))
        #expect(!context.summary.contains("confidential"))
        #expect(!context.summary.contains("Private"))
        #expect(context.summary.contains("caret 12/0/0 chars"))
    }

    // MARK: Terminal visible lines

    @Test func firstVisibleLineFindsTheWindowTop() {
        // 1000 lines of 16 pt; the window's top edge sits at line 900.
        let top = ScreenContext.firstVisibleLine(lineCount: 1000, windowTop: 900 * 16) { CGFloat($0 * 16) }
        #expect(top == 900)
    }

    @Test func firstVisibleLineIsNilWhenEveryLineIsAbove() {
        #expect(ScreenContext.firstVisibleLine(lineCount: 10, windowTop: 1000) { CGFloat($0) } == nil)
    }

    @Test func firstVisibleLineGivesUpWhenALineHasNoBounds() {
        #expect(ScreenContext.firstVisibleLine(lineCount: 10, windowTop: 5) { _ in nil } == nil)
    }

    // MARK: Terminal program

    @Test func activePaneIsTheMostRecentlyActiveClients() {
        let output = "1700000100 %1 /dev/ttys003 0 0\n1700000900 %7 /dev/ttys034 2 40\n1700000500 %3 /dev/ttys010 5 5\n"
        #expect(ScreenContext.activePane(fromTmuxClients: output) == .init(id: "%7", tty: "/dev/ttys034", cursorX: 2, cursorY: 40))
    }

    @Test func noTmuxClientsMeansNoPane() {
        #expect(ScreenContext.activePane(fromTmuxClients: "") == nil)
        #expect(ScreenContext.activePane(fromTmuxClients: "garbage line\n") == nil)
    }

    @Test func paneSplitsAtTheCursorCell() {
        let screen = "first line\n> hello world\nstatus bar\n\n\n"
        let split = ScreenContext.splitAtCursor(screen, line: 1, column: 7)
        #expect(split.before == "first line\n> hello")
        #expect(split.after == " world\nstatus bar")
    }

    /// A cursor after typed spaces sits past the line's trimmed end: pad, don't crash or wrap.
    @Test func paneCursorPastTheLineEndIsPadded() {
        let split = ScreenContext.splitAtCursor("> hi\nnext", line: 0, column: 6)
        #expect(split.before == "> hi  ")
        #expect(split.after == "\nnext")
    }

    @Test func paneCursorBelowTheTextKeepsEverythingBefore() {
        let split = ScreenContext.splitAtCursor("only line", line: 5, column: 0)
        #expect(split.before == "only line")
        #expect(split.after == "")
    }

    /// Side-by-side panes: every pane line is a substring of a wider screen line.
    @Test func paneShownBesideAnotherPaneIsOnScreen() {
        let pane = "$ make test\nall passed\n\n"
        let screen = "left pane text      │$ make test\nmore left text      │all passed\n"
        #expect(ScreenContext.paneIsOnScreen(pane: pane, screen: screen, sampleLines: 12, requiredShare: 0.75))
    }

    /// tmux attached in another tab: its pane text isn't on the terminal in front.
    @Test func paneFromAnotherTabIsNotOnScreen() {
        let pane = "$ make test\nall passed\n"
        let screen = "user@host ~ % ls\nDocuments Downloads\n"
        #expect(!ScreenContext.paneIsOnScreen(pane: pane, screen: screen, sampleLines: 12, requiredShare: 0.75))
    }

    @Test func blankPaneIsNotEvidence() {
        #expect(!ScreenContext.paneIsOnScreen(pane: "\n  \n", screen: "anything", sampleLines: 12, requiredShare: 0.75))
    }

    /// Children of the foreground program share its tty; only the process-group leader counts.
    @Test func foregroundProgramIsTheProcessGroupLeader() {
        let output = """
          2798  4933 caffeinate
          4933  4933 /usr/local/bin/claude
          5001  4933 sourcekit-lsp
         34742  4933 -zsh
        """
        #expect(ScreenContext.foregroundProgram(fromPS: output) == "claude")
    }
}

/// The helper commands (tmux, ps) run while the context is read, and the dictation's cleanup waits
/// for that context: a command that never finishes must not hold it up.
struct ScreenContextCommandTests {
    @Test func returnsTheOutputOfACommandThatFinishes() {
        #expect(ScreenContextReader.run("/bin/echo", ["pane text"]) == "pane text\n")
    }

    @Test func stopsACommandThatDoesNotFinish() throws {
        let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("tabmail-tests-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }
        let clock = ContinuousClock()
        let started = clock.now
        #expect(ScreenContextReader.run("/bin/sh", ["-c", #"echo $$ > "$0"; exec sleep 5"#, pidFile.path], timeout: 0.2) == nil)
        #expect(clock.now - started < .seconds(2))
        #expect(Self.exits(try Self.pid(in: pidFile)))
    }

    /// Output ends (EOF) but the command keeps running: it is stopped at the deadline all the same.
    @Test func stopsACommandThatClosesItsOutputAndKeepsRunning() throws {
        let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("tabmail-tests-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }
        let clock = ContinuousClock()
        let started = clock.now
        #expect(ScreenContextReader.run("/bin/sh", ["-c", #"echo $$ > "$0"; exec >&-; exec sleep 5"#, pidFile.path], timeout: 0.2) == nil)
        #expect(clock.now - started < .seconds(2))
        #expect(Self.exits(try Self.pid(in: pidFile)))
    }

    /// A stopped tmux server holds the client's output open, so it never ends even after the client
    /// exits. Here a background child holds it the same way after the shell exits.
    @Test func givesUpOnOutputThatNeverEnds() {
        let clock = ContinuousClock()
        let started = clock.now
        #expect(ScreenContextReader.run("/bin/sh", ["-c", "sleep 5 & echo partial"], timeout: 0.2) == nil)
        #expect(clock.now - started < .seconds(2))
    }

    /// The process id a test command wrote to `file`.
    private static func pid(in file: URL) throws -> pid_t {
        try #require(pid_t(String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    /// Whether `pid` is gone within a second. Kills it if not, so a failing run leaves nothing behind.
    private static func exits(_ pid: pid_t) -> Bool {
        let deadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < deadline {
            if kill(pid, 0) == -1, errno == ESRCH { return true }
            usleep(10_000)
        }
        kill(pid, SIGKILL)
        return false
    }
}

/// Every dictation reads the screen through the probe; without it, every cleanup silently runs
/// without context.
@MainActor
struct ScreenContextProbeTests {
    private static let notes = ScreenContextProbe.Target(pid: 101, name: "Example Notes", bundleID: "com.example.notes")
    private static let browser = ScreenContextProbe.Target(pid: 202, name: "Example Browser", bundleID: "com.example.browser")

    /// Records which apps were read.
    private final class Reads: @unchecked Sendable {
        private let names = OSAllocatedUnfairLock<[String]>(initialState: [])
        var all: [String] { names.withLock { $0 } }
        func record(_ target: ScreenContextProbe.Target) -> ScreenContext {
            names.withLock { $0.append(target.name) }
            return ScreenContext(appName: target.name, bundleID: target.bundleID)
        }
    }

    @Test func withoutTheAccessibilityGrantNothingIsRead() {
        let reads = Reads()
        let probe = ScreenContextProbe(isTrusted: { false }, frontmostApp: { Self.notes }, read: { reads.record($0) })
        #expect(probe.capture() == nil)
        #expect(reads.all.isEmpty)
    }

    @Test func withoutAFrontmostAppNothingIsRead() {
        let reads = Reads()
        let probe = ScreenContextProbe(isTrusted: { true }, frontmostApp: { nil }, read: { reads.record($0) })
        #expect(probe.capture() == nil)
        #expect(reads.all.isEmpty)
    }

    /// The app is the one in front when the dictation starts, not whichever is in front by the time
    /// the read runs.
    @Test func readsTheAppInFrontWhenCalled() async {
        let reads = Reads()
        var front = Self.notes
        let probe = ScreenContextProbe(isTrusted: { true }, frontmostApp: { front }, read: { reads.record($0) })
        let task = probe.capture()
        front = Self.browser
        let context = await task?.value
        #expect(context?.appName == "Example Notes")
        #expect(context?.bundleID == "com.example.notes")
        #expect(reads.all == ["Example Notes"])
    }

    /// A dictation whose read finishes after a newer one started still gets its own screen; the
    /// debug window shows the newest.
    @Test func aSupersededCaptureStillYieldsItsOwnScreen() async {
        let reads = Reads()
        let (gate, opener) = AsyncStream.makeStream(of: Never.self)
        var front = Self.notes
        let probe = ScreenContextProbe(isTrusted: { true }, frontmostApp: { front }, read: { target in
            if target.name == "Example Notes" { for await _ in gate {} }
            return reads.record(target)
        })
        let first = probe.capture()
        front = Self.browser
        let second = probe.capture()

        #expect(await second?.value.appName == "Example Browser")
        #expect(probe.lastContext?.appName == "Example Browser")
        opener.finish()
        #expect(await first?.value.appName == "Example Notes")
        #expect(probe.lastContext?.appName == "Example Browser")
        #expect(reads.all == ["Example Browser", "Example Notes"])
    }
}
