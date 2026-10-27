// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import CoreGraphics
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

struct ScreenContextTests {
    // MARK: Visible text

    @Test func appendSkipsBlanksAndRepeats() throws {
        var context = ScreenContext(appName: "Example")
        context.append(.link, "Inbox")
        context.append(.text, "Inbox")
        context.append(.text, "  ")
        context.append(.text, " Drafts\n")
        // An edge that had space keeps one, or a line break if it held one, so the render can tell
        // two words, and two lines, from pieces that abut.
        #expect(context.blocks == [.init(kind: .link, text: "Inbox"), .init(kind: .text, text: " Drafts\n")])
    }

    @Test func renderedTextMarksStructure() throws {
        var context = ScreenContext(appName: "Example")
        context.append(.heading, "Results")
        context.append(.row, "Paper | 2024 | 12")
        context.append(.link, "Next page")
        context.append(.field, "line one\nline two")
        context.append(.text, "Plain")
        #expect(try context.renderedText() == "## Results\n| Paper | 2024 | 12\n[Next page]\n> line one\n> line two\nPlain")
    }

    /// The focused field sits between the text above and below it, with the caret marked.
    @Test func caretBlockKeepsItsPlaceInTheReadingOrder() throws {
        var context = ScreenContext(appName: "Example")
        context.textBeforeCaret = "Draft "
        context.textAfterCaret = "reply"
        context.append(.text, "Earlier comment")
        context.appendCaret()
        context.append(.text, "Footer")
        #expect(try context.renderedText() == "Earlier comment\n» Draft ‸reply\nFooter")
    }

    @Test func emptyFocusedFieldStillMarksTheCaret() throws {
        var context = ScreenContext(appName: "Example")
        context.appendCaret()
        #expect(try context.renderedText() == "» ‸")
    }

    @Test func privateNeighborsDoNotDisplaceLateVisibleContext() throws {
        let limits = try SharedContext.sourceLimits()
        let screenBytes = limits.selectionSourceBytes + 6
        var context = ScreenContext(appName: "Synthetic page")
        context.textBeforeCaret = "private prefix. " + String(repeating: "a ", count: 3000)
        context.selectedText = "chosen"
        context.textAfterCaret = String(repeating: " b", count: 3000) + ". private suffix"
        context.caretSelectionOnly = true
        context.append(.text, String(repeating: "z", count: screenBytes - 100))
        #expect(!context.textBudgetFull)
        context.append(.text, "visible-tail-marker")
        #expect(context.blocks.count == 2)
        let reply = context.json(ScreenExclusions())
        #expect(reply["selectedText"]?.string == "chosen")
        #expect(reply["renderedText"]?.string?.contains("visible-tail-marker") == true)
        #expect(reply["textBeforeCaret"]?.string == "")
        #expect(reply["textAfterCaret"]?.string == "")
    }

    @Test func selectionIsBracketedByCaretMarkers() throws {
        var context = ScreenContext(appName: "Example")
        context.textBeforeCaret = "a "
        context.selectedText = "b"
        context.textAfterCaret = " c"
        context.appendCaret()
        #expect(try context.renderedText() == "» a ‸b‸ c")
    }

    // MARK: Layout

    /// A Slack message as its Accessibility frames report it (measured 2026-09-26): the author
    /// button and the time link share a line, the text below wraps onto a second line where an
    /// emoji splits it, and the thread pane to the right starts back at the window's top.
    @Test func renderedTextLaysTextOutInLinesAsOnScreen() throws {
        var context = ScreenContext(appName: "Slack")
        context.append(.text, "Alex", frame: CGRect(x: 868, y: 874, width: 52, height: 25))
        context.append(.link, "Today at 9:20:09 AM", frame: CGRect(x: 928, y: 880, width: 51, height: 16))
        context.append(.text, "The draft is ready for review", frame: CGRect(x: 868, y: 900, width: 590, height: 45))
        context.append(.text, "Let me know what you think", frame: CGRect(x: 940, y: 925, width: 278, height: 20))
        context.append(.text, "10 replies", frame: CGRect(x: 933, y: 955, width: 63, height: 21))
        context.append(.heading, "Thread", frame: CGRect(x: 1510, y: 160, width: 80, height: 24))
        context.append(.text, "Sam Lee", frame: CGRect(x: 1560, y: 200, width: 124, height: 25))
        #expect(try context.renderedText() == """
            Alex [Today at 9:20:09 AM]
            The draft is ready for review Let me know what you think
            10 replies

            ## Thread
            Sam Lee
            """)
    }

    /// Only text and links flow: a heading, row, field or the caret block starts its own line even
    /// beside other text, and so does text to the left of the previous piece.
    @Test func onlyTextAndLinksShareALine() throws {
        let line = CGRect(x: 0, y: 100, width: 50, height: 20)
        func separator(_ first: ScreenContext.Block.Kind, _ second: ScreenContext.Block.Kind, secondX: CGFloat = 60) -> String {
            ScreenContext.separator(between: .init(kind: first, text: "a", frame: line),
                                    and: .init(kind: second, text: "b", frame: line.offsetBy(dx: secondX, dy: 0)))
        }
        #expect(separator(.text, .link) == " ")
        #expect(separator(.link, .text) == " ")
        for kind in [ScreenContext.Block.Kind.heading, .row, .field, .caret] {
            #expect(separator(.text, kind) == "\n")
            #expect(separator(kind, .text) == "\n")
        }
        #expect(separator(.text, .text, secondX: -60) == "\n")
    }

    /// Two pieces share a line when they overlap by half the shorter's height, not by a sliver.
    @Test func aSliverOfOverlapIsNotOneLine() throws {
        let first = ScreenContext.Block(kind: .text, text: "a", frame: CGRect(x: 0, y: 100, width: 50, height: 20))
        func second(y: CGFloat) -> ScreenContext.Block { .init(kind: .text, text: "b", frame: CGRect(x: 60, y: y, width: 50, height: 20)) }
        #expect(ScreenContext.separator(between: first, and: second(y: 110)) == " ")
        #expect(ScreenContext.separator(between: first, and: second(y: 111)) == "\n")
        #expect(ScreenContext.separator(between: first, and: second(y: 120)) == "\n")
    }

    /// Text wholly above the previous piece is the next pane or column: a blank line between.
    @Test func aJumpBackUpLeavesABlankLine() throws {
        let first = ScreenContext.Block(kind: .text, text: "a", frame: CGRect(x: 0, y: 500, width: 50, height: 20))
        func second(y: CGFloat) -> ScreenContext.Block { .init(kind: .text, text: "b", frame: CGRect(x: 600, y: y, width: 50, height: 20)) }
        #expect(ScreenContext.separator(between: first, and: second(y: 100)) == "\n\n")
        #expect(ScreenContext.separator(between: first, and: second(y: 480)) == "\n\n")
        #expect(ScreenContext.separator(between: first, and: second(y: 485)) == "\n")
    }

    @Test func withoutFramesEveryPieceHasItsOwnLine() throws {
        let framed = ScreenContext.Block(kind: .text, text: "a", frame: CGRect(x: 0, y: 0, width: 50, height: 20))
        let unframed = ScreenContext.Block(kind: .text, text: "b")
        #expect(ScreenContext.separator(between: framed, and: unframed) == "\n")
        #expect(ScreenContext.separator(between: unframed, and: framed) == "\n")
    }

    @Test func caretBlockKeepsItsFrame() throws {
        var context = ScreenContext(appName: "Example")
        let frame = CGRect(x: 10, y: 20, width: 300, height: 40)
        context.appendCaret(frame: frame)
        #expect(context.blocks.first?.frame == frame)
    }

    // MARK: What is read

    /// Web apps keep hidden text in boxes at most a point thin (frames measured in Slack and
    /// Chrome 2026-09-26), and Chrome squashes everything scrolled out of view to such a strip at the
    /// window's edge: reading what the window shows, it is skipped. Reading the whole window
    /// (ADR-DESK-016 amendment, 2026-10-25) it is read, marked unplaced by the shared core so it
    /// starts a line of its own. A 0×0 frame says nothing either way: shown, and laid out as given.
    @Test func textInAPointThinBoxIsReadOnlyWithTheWholeWindow() throws {
        func step(_ frame: CGRect, whole: Bool) throws -> SharedWalk.Step {
            var node = SharedWalk.Node(role: "text", inPage: true, frame: frame, window: nil)
            node.wholeWindow = whole
            return try SharedWalk.node(node)
        }
        for thin in [CGRect(x: 945, y: 234, width: 147, height: 1),   // scrolled out of Slack's list
                     CGRect(x: 2099, y: 278, width: 0, height: 1),    // scrolled out in Chrome
                     CGRect(x: 1477, y: 774, width: 1, height: 36),   // hover-only action
                     CGRect(x: 797, y: 146, width: 1, height: 1)] {   // screen-reader-only
            #expect(try step(thin, whole: false).action == .skip)
            #expect(try step(thin, whole: true).action == .text)
            #expect(try step(thin, whole: true).unplaced == true)
        }
        for placed in [CGRect(x: 868, y: 874, width: 52, height: 25), CGRect(x: 0, y: 0, width: 2, height: 2), .zero] {
            for whole in [false, true] {
                #expect(try step(placed, whole: whole).action == .text)
                #expect(try step(placed, whole: whole).unplaced == nil)
            }
        }
    }

    /// In web content controls and toolbars are read; in native apps they stay skipped, and
    /// images, menus and scroll bars everywhere: this helper's AX roles as the shared core's.
    @Test func controlsAndToolbarsAreReadOnlyInWebContent() throws {
        func action(_ role: String, inWeb: Bool) throws -> SharedWalk.Step.Action {
            try SharedWalk.node(.init(role: HelperConfig.contextRoles[role] ?? "other", inPage: inWeb, frame: nil, window: nil)).action
        }
        for role in ["AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton"] {
            #expect(try action(role, inWeb: true) == .caption)
            #expect(try action(role, inWeb: false) == .skip)
        }
        #expect(try action("AXToolbar", inWeb: true) == .descend)
        #expect(try action("AXToolbar", inWeb: false) == .skip)
        for role in ["AXImage", "AXMenu", "AXMenuItem", "AXMenuBar", "AXScrollBar", "AXSlider", "AXIncrementor"] {
            #expect(try action(role, inWeb: true) == .skip)
        }
        #expect(try action("AXStaticText", inWeb: false) == .text)
        #expect(try action("AXGroup", inWeb: false) == .descend)
    }

    /// A web control's title is text drawn in it only when it has no description: Slack's message
    /// author has a title alone; an icon button a description (Slack) or both (an Electron chat
    /// app's "Copy").
    @Test func aControlsTitleIsItsTextOnlyWithoutADescription() throws {
        #expect(ScreenContextReader.drawnTitle(title: "Alex", description: nil) == "Alex")
        #expect(ScreenContextReader.drawnTitle(title: "10 replies", description: " ") == "10 replies")
        #expect(ScreenContextReader.drawnTitle(title: nil, description: "Add reaction…") == nil)
        #expect(ScreenContextReader.drawnTitle(title: "Copy", description: "Copy") == nil)
        #expect(ScreenContextReader.drawnTitle(title: "  ", description: nil) == nil)
    }

    @Test func framesWithoutASizeHaveTheirOwnLines() throws {
        let empty = ScreenContext.Block(kind: .text, text: "a", frame: .zero)
        let flat = ScreenContext.Block(kind: .text, text: "b", frame: CGRect(x: 60, y: 0, width: 50, height: 0))
        #expect(ScreenContext.separator(between: empty, and: empty) == "\n")
        #expect(ScreenContext.separator(between: empty, and: flat) == "\n")
    }

    // MARK: Walk

    /// A Slack DM as its Accessibility tree has it (shape measured 2026-09-26, names and text
    /// replaced): the messages sit in a 1×2 screen-reader-only list inside the web area; an author
    /// is a button titled with its name; a message scrolled out of view is 1 point tall; icon
    /// buttons carry a description (and, in one Electron app, the same text as the title); an
    /// author button also holds its name as child text; the focused composer is below.
    private func slackWindow(webArea role: String = "AXWebArea") -> (window: FakeElement, focused: FakeElement, focusPath: [FakeElement]) {
        let composer = FakeElement("AXTextArea", frame: CGRect(x: 820, y: 1143, width: 652, height: 43))
        let composerGroup = FakeElement("AXGroup", frame: CGRect(x: 820, y: 1101, width: 654, height: 130), children: [composer])
        let scrolledOut = FakeElement("AXGroup", frame: CGRect(x: 798, y: 234, width: 698, height: 1), children: [
            FakeElement("AXButton", [kAXTitleAttribute: "Alex"], frame: CGRect(x: 868, y: 234, width: 52, height: 1)),
            FakeElement("AXLink", [kAXDescriptionAttribute: "Yesterday at 4:15 PM"], frame: CGRect(x: 928, y: 234, width: 50, height: 1)),
            FakeElement("AXStaticText", [kAXValueAttribute: "An old message"], frame: CGRect(x: 868, y: 234, width: 313, height: 1)),
        ])
        let message = FakeElement("AXGroup", frame: CGRect(x: 798, y: 870, width: 698, height: 119), children: [
            FakeElement("AXButton", [kAXTitleAttribute: "Alex Lee"], frame: CGRect(x: 868, y: 874, width: 52, height: 25), children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Alex"], frame: CGRect(x: 868, y: 874, width: 30, height: 25)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Lee"], frame: CGRect(x: 900, y: 874, width: 20, height: 25)),
            ]),
            FakeElement("AXLink", [kAXDescriptionAttribute: "Today at 9:20 AM"], frame: CGRect(x: 928, y: 880, width: 51, height: 16)),
            FakeElement("AXStaticText", [kAXValueAttribute: "The draft is ready for review"], frame: CGRect(x: 868, y: 900, width: 590, height: 45)),
            FakeElement("AXButton", [kAXTitleAttribute: "Copy", kAXDescriptionAttribute: "Copy"], frame: CGRect(x: 1400, y: 880, width: 26, height: 27)),
            FakeElement("AXButton", [kAXDescriptionAttribute: "Add reaction"], frame: CGRect(x: 1430, y: 880, width: 26, height: 27)),
        ])
        let list = FakeElement("AXList", frame: CGRect(x: 798, y: 1108, width: 1, height: 2), children: [scrolledOut, message])
        let web = FakeElement(role, frame: CGRect(x: 0, y: 0, width: 1600, height: 1200),
                              children: [list, composerGroup])
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 1600, height: 1200), children: [web])
        return (window, composer, [composerGroup, web, window])
    }

    private func walk(_ window: FakeElement, focused: FakeElement? = nil, focusPath: [FakeElement] = [], whole: Bool = false) -> ScreenContext {
        var context = ScreenContext(appName: "Example")
        context.wholeWindow = whole
        let read = ScreenContextReader.walk(window, in: FakeScreenTree(), frame: window.frame, focused: focused,
                                            focusPath: focusPath, excluding: ScreenExclusions(), into: &context)
        #expect(read)
        return context
    }

    /// Who wrote a message reaches the prompt: the author and time on one line, the message below,
    /// with neither scrolled-out text nor icon labels, and the caret block after. Reading the whole
    /// window (ADR-DESK-016 amendment), the message scrolled out of view is read too, each of its
    /// point-thin pieces on a line of its own.
    @Test func walkReadsAWebChatAsItsScreenShowsIt() throws {
        let slack = slackWindow()
        let context = walk(slack.window, focused: slack.focused, focusPath: slack.focusPath)
        #expect(try context.renderedText() == "Alex Lee [Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
        #expect(context.blocks.last?.frame == slack.focused.frame)
        let whole = walk(slack.window, focused: slack.focused, focusPath: slack.focusPath, whole: true)
        let text = try whole.renderedText()
        #expect(text == "Alex\n[Yesterday at 4:15 PM]\nAn old message\nAlex Lee [Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
        #expect(whole.blocks.last?.frame == slack.focused.frame)
    }

    /// A key split by styling where one piece wraps (a Slack message) is read whole: the pieces meet
    /// where the text of the one before ends and the next one's starts, not across a wrapped
    /// piece's frame, which covers all its lines. Text and link pieces alike.
    @Test func walkJoinsPiecesWhereAWrappedPieceEnds() throws {
        func piece(_ role: String, _ text: String, _ frame: CGRect, _ first: CGRect, _ last: CGRect) -> FakeElement {
            let element = FakeElement(role, role == "AXLink" ? [kAXDescriptionAttribute: text] : [kAXValueAttribute: text], frame: frame)
            element.ends = [first, last]
            return element
        }
        func box(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(x: x, y: y, width: 8, height: 20) }
        let area = FakeElement("AXWebArea", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [
            piece("AXStaticText", "Wrap words that wrap onto a second line sk-Review" + "Wrap", CGRect(x: 0, y: 0, width: 200, height: 40), box(0, 0), box(142, 20)),
            piece("AXStaticText", "Glued" + "1234567890ab end", CGRect(x: 150, y: 20, width: 120, height: 20), box(150, 20), box(262, 20)),
            piece("AXStaticText", "Start sk-Review" + "Start", CGRect(x: 0, y: 100, width: 150, height: 20), box(0, 100), box(142, 100)),
            piece("AXLink", "Tail" + "1234567890abcd words that wrap onto more lines", CGRect(x: 0, y: 100, width: 200, height: 40), box(150, 100), box(0, 120)),
        ])
        let context = walk(FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [area]))
        #expect(context.json["renderedText"]?.string == "Wrap words that wrap onto a second line [redacted] end\nStart [redacted] [words that wrap onto more lines]")
    }

    /// Outside web content a control's title may be an icon's label, so controls stay skipped.
    @Test func walkSkipsControlsOutsideWebContent() throws {
        let native = slackWindow(webArea: "AXGroup")
        let context = walk(native.window, focused: native.focused, focusPath: native.focusPath)
        #expect(try context.renderedText() == "[Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
        let text = try walk(native.window, focused: native.focused, focusPath: native.focusPath, whole: true).renderedText()
        #expect(text == "[Yesterday at 4:15 PM]\nAn old message\n[Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
    }

    /// A heading, link, row or field in a point-thin box shows nothing, like text; the one shown
    /// piece beside them proves the walk reached them. Reading the whole window (ADR-DESK-016
    /// amendment) each is read, starting a line of its own, since its box says nothing of where it is.
    @Test func walkReadsEveryKindOfBlockInAPointThinBox() throws {
        let thin = CGRect(x: 10, y: 50, width: 300, height: 1)
        let area = FakeElement("AXWebArea", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [
            FakeElement("AXHeading", [kAXTitleAttribute: "Thin heading"], frame: thin),
            FakeElement("AXLink", [kAXDescriptionAttribute: "Thin link"], frame: thin),
            FakeElement("AXRow", [kAXDescriptionAttribute: "Thin row"], frame: thin),
            FakeElement("AXTextField", [kAXValueAttribute: "Thin field"], frame: thin),
            FakeElement("AXStaticText", [kAXValueAttribute: "Shown"], frame: CGRect(x: 10, y: 100, width: 60, height: 20)),
        ])
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [area])
        #expect(try walk(window).renderedText() == "Shown")
        #expect(try walk(window, whole: true).renderedText() == "## Thin heading\n[Thin link]\n| Thin row\n> Thin field\nShown")
    }

    /// Reading what the window shows, the page scrolled out of view is left out. Reading the whole
    /// window it is read, as Chrome reports it (every element squashed to a
    /// point-thin strip at the window's bottom edge, measured 2026-10-25) and as Safari and Firefox
    /// do (true frames below the window): Chrome's pieces each start a line, never joined side by
    /// side as one strip; Safari's are laid out by their frames as on screen.
    @Test func walkReadsThePageScrolledOutOfView() throws {
        let window = CGRect(x: 0, y: 0, width: 800, height: 600)
        func page(_ frames: [CGRect]) -> FakeElement {
            FakeElement("AXWindow", frame: window, children: [FakeElement("AXWebArea", frame: window, children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "On screen"], frame: CGRect(x: 10, y: 100, width: 80, height: 20)),
                FakeElement("AXHeading", [kAXTitleAttribute: "Section two"], frame: frames[0]),
                FakeElement("AXStaticText", [kAXValueAttribute: "First part"], frame: frames[1]),
                FakeElement("AXStaticText", [kAXValueAttribute: "second part"], frame: frames[2]),
            ])])
        }
        let strip = CGRect(x: 10, y: 599, width: 300, height: 1)
        let safari = [CGRect(x: 10, y: 1500, width: 200, height: 30), CGRect(x: 10, y: 1540, width: 80, height: 20),
                      CGRect(x: 95, y: 1540, width: 90, height: 20)]
        #expect(try walk(page([strip, strip, strip])).renderedText() == "On screen")
        #expect(try walk(page(safari)).renderedText() == "On screen")
        #expect(try walk(page([strip, strip, strip]), whole: true).renderedText() == "On screen\n## Section two\nFirst part\nsecond part")
        #expect(try walk(page(safari), whole: true).renderedText() == "On screen\n## Section two\nFirst part second part")
    }

    /// The app stopped waiting (`readScreenStop`): the walk ends at its next element, and what it read
    /// so far is the read, said to have stopped. Nothing of the elements after the stop is read.
    @Test func aStoppedWalkKeepsWhatItReadSoFar() throws {
        let pieces = (1...5).map { FakeElement("AXStaticText", [kAXValueAttribute: "Piece \($0)"]) }
        let window = FakeElement("AXWindow", children: [FakeElement("AXWebArea", children: pieces)])
        var context = ScreenContext(appName: "Example")
        // Asked once the second piece is read.
        let walked = ScreenContextReader.walk(window, in: FakeScreenTree(), frame: nil, focused: nil, focusPath: [], excluding: ScreenExclusions(),
                                              into: &context, asked: { pieces[1].textReads > 0 })
        #expect(walked)
        #expect(context.stoppedEarly == "asked")
        #expect(try context.renderedText() == "Piece 1\nPiece 2")
        #expect(pieces[2...].allSatisfy { $0.textReads == 0 })
    }

    /// A stop that comes while a row is being read ends the row at its next piece: what was read of
    /// it is kept, and nothing of the pieces after the stop is asked for.
    @Test func aStopInsideARowKeepsWhatItReadOfTheRow() throws {
        func read(stopping: Bool) throws -> (rendered: String, cells: [FakeElement], lateRoles: Int) {
            let cells = (1...5).map { FakeElement("AXStaticText", [kAXValueAttribute: "Cell \($0)"]) }
            let tree = StopTree(stopsAt: nil)
            var lateRoles = 0
            tree.onString = { element, name in
                if name == kAXRoleAttribute, cells[2...].contains(where: { $0 === element }) { lateRoles += 1 }
            }
            var context = ScreenContext(appName: "Example")
            let walked = ScreenContextReader.walk(FakeElement("AXWindow", children: [FakeElement("AXRow", children: cells)]), in: tree,
                                                  frame: nil, focused: nil, focusPath: [], excluding: ScreenExclusions(), into: &context,
                                                  asked: { stopping && cells[1].textReads > 0 })
            #expect(walked)
            return (try context.renderedText(), cells, lateRoles)
        }
        let stopped = try read(stopping: true)
        #expect(stopped.rendered == "| Cell 1 | Cell 2")
        #expect(stopped.cells[2...].allSatisfy { $0.textReads == 0 })
        #expect(stopped.lateRoles == 0)
        #expect(try read(stopping: false).rendered == "| Cell 1 | Cell 2 | Cell 3 | Cell 4 | Cell 5")
    }

    /// A stop that comes while a field is looked through for a framed page leaves the field
    /// unread, said hidden, and ends the read there, alone or in a row.
    @Test func aStopDuringAFieldsLookWithholdsTheField() throws {
        for inRow in [false, true] {
            func read(stopping: Bool) throws -> (rendered: String, field: FakeElement, looks: Int) {
                let field = FakeElement("AXTextArea", [kAXValueAttribute: "Whole field"], children: [FakeElement("AXGroup")])
                let tree = StopTree(stopsAt: stopping ? field : nil)
                let nodes = [FakeElement("AXStaticText", [kAXValueAttribute: "Prefix"]), field,
                             FakeElement("AXStaticText", [kAXValueAttribute: "Later piece"])]
                let window = FakeElement("AXWindow", children: inRow ? [FakeElement("AXRow", children: nodes)] : nodes)
                var context = ScreenContext(appName: "Example")
                let walked = ScreenContextReader.walk(window, in: tree, frame: nil, focused: nil, focusPath: [], excluding: ScreenExclusions(),
                                                      into: &context, asked: { tree.asked })
                #expect(walked)
                return (try context.renderedText(), field, tree.looks)
            }
            let stopped = try read(stopping: true)
            #expect(stopped.looks > 0)
            #expect(stopped.rendered.contains("Prefix") && stopped.rendered.contains("[hidden for privacy]"))
            #expect(!stopped.rendered.contains("Whole field") && !stopped.rendered.contains("Later piece"))
            #expect(stopped.field.textReads == 0)
            let whole = try read(stopping: false)
            #expect(whole.rendered.contains("Whole field") && whole.rendered.contains("Later piece"))
        }
    }

    /// A password field is never read, whether or not the app hides its value: not in the window, not
    /// in a row, not its child text, not when it is a web control.
    @Test func walkNeverReadsAPasswordField() throws {
        let secure = [kAXSubroleAttribute: kAXSecureTextFieldSubrole as String, kAXValueAttribute: "placeholder-secret"]
        let area = FakeElement("AXWebArea", children: [
            FakeElement("AXTextField", secure, children: [FakeElement("AXStaticText", [kAXValueAttribute: "placeholder-secret"])]),
            FakeElement("AXRow", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Sign in"]),
                FakeElement("AXTextField", secure, children: [FakeElement("AXStaticText", [kAXValueAttribute: "placeholder-secret"])]),
            ]),
            FakeElement("AXButton", secure.merging([kAXTitleAttribute: "placeholder-secret"]) { $1 }),
        ])
        let window = FakeElement("AXWindow", children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Account"]),
            FakeElement("AXTextField", secure),
            FakeElement("AXTextArea", secure),
            area,
        ])
        let text = try walk(window).renderedText()
        #expect(text == "Account\n| Sign in")
        #expect(!text.contains("placeholder-secret"))
    }

    /// The focused field's text is read around the caret, unless it is a password field; the caret
    /// still marks its place.
    @Test func theFocusedPasswordFieldIsNeverRead() throws {
        let caret = ["caretBefore": "placeholder-", "caretSelected": "sec", "caretAfter": "ret"]
        var plain = ScreenContext(appName: "Example")
        ScreenContextReader.readCaret(of: FakeElement("AXTextField", caret), in: FakeScreenTree(), into: &plain)
        #expect(plain.textBeforeCaret == "placeholder-")
        #expect(plain.selectedText == "sec")
        #expect(plain.textAfterCaret == "ret")

        let field = FakeElement("AXTextField", caret.merging([kAXSubroleAttribute: kAXSecureTextFieldSubrole as String]) { $1 })
        let window = FakeElement("AXWindow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "Password"]), field])
        var context = ScreenContext(appName: "Example")
        ScreenContextReader.readCaret(of: field, in: FakeScreenTree(), into: &context)
        #expect(ScreenContextReader.walk(window, in: FakeScreenTree(), frame: nil, focused: field, focusPath: [],
                                         excluding: ScreenExclusions(), into: &context))
        #expect(context.textBeforeCaret.isEmpty && context.selectedText.isEmpty && context.textAfterCaret.isEmpty)
        #expect(try context.renderedText() == "Password\n» ‸")
        #expect(try !context.logDescription.contains("placeholder"))
    }

    /// An app that reports no frames is read in full, as before frames were read: no frame counts
    /// as shown, in the walk and in a row's text.
    @Test func semanticFieldsKeepPrivateRecognitionSourceUntilFinalRedaction() throws {
        for role in ["AXRow", "AXHeading", "AXLink"] {
            let field = FakeElement("AXTextArea", [kAXValueAttribute: "syntheticSecret123", "fieldBefore": "password: "])
            let container = FakeElement(role, children: [FakeElement("AXStaticText", [kAXValueAttribute: "Label"]), field])
            let result = try walk(FakeElement("AXWindow", children: [container])).renderedText()
            #expect(result.contains("[redacted]"))
            #expect(!result.contains("syntheticSecret") && !result.contains("password:"))
            #expect(field.textReads == 1)
        }
    }

    @Test func staticAndLabelSnapshotsWithholdIncompleteCredentialSuffixes() throws {
        // Longer than a piece of text is read: it is cut, and the credential the cut leaves open is withheld.
        let text = "Visible. password: " + String(repeating: "x", count: try SharedContext.limit("blockSourceBytes"))
        let plain = FakeElement("AXStaticText", [kAXValueAttribute: text])
        let heading = FakeElement("AXHeading", [kAXTitleAttribute: text])
        #expect(try walk(FakeElement("AXWindow", children: [plain])).renderedText() == "Visible.")
        #expect(try walk(FakeElement("AXWindow", children: [heading])).renderedText() == "## Visible.")
        #expect(try BoundedCaretSource.snapshot("é😀 Caption" as NSString) == "é😀 Caption")
    }

    @Test func semanticFieldWithoutAValueRetainsItsCaption() throws {
        let field = FakeElement("AXTextArea", [kAXTitleAttribute: "Fallback caption"])
        let row = FakeElement("AXRow", children: [field])
        #expect(try walk(FakeElement("AXWindow", children: [row])).renderedText() == "| Fallback caption")
    }

    @Test func walkReadsElementsWithoutFrames() throws {
        let row = FakeElement("AXRow", children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Cell one"]),
            FakeElement("AXStaticText", [kAXValueAttribute: "Cell two"]),
        ])
        let window = FakeElement("AXWindow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "Plain"]), row])
        #expect(try walk(window).renderedText() == "Plain\n| Cell one | Cell two")
    }

    /// In web content a toolbar's text is read (a chat's header with the conversation's name), and
    /// a control with a screen-reader label still shows its drawn child text; in native apps both
    /// stay skipped.
    @Test func webToolbarsAndLabeledControlsKeepTheirShownText() throws {
        let shown = CGRect(x: 20, y: 40, width: 100, height: 20)
        let thin = CGRect(x: 20, y: 40, width: 100, height: 1)
        func read(_ element: FakeElement, inside role: String, whole: Bool = false) -> String {
            try! walk(FakeElement("AXWindow", children: [FakeElement(role, children: [element])]), whole: whole).renderedText()
        }
        let toolbar = FakeElement("AXToolbar", children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Project chat"], frame: shown),
            FakeElement("AXStaticText", [kAXValueAttribute: "Thin label"], frame: thin),
        ])
        #expect(read(toolbar, inside: "AXWebArea") == "Project chat")
        #expect(read(toolbar, inside: "AXWebArea", whole: true) == "Project chat\nThin label")
        #expect(read(toolbar, inside: "AXGroup") == "")
        for role in ["AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton"] {
            let control = FakeElement(role, [kAXTitleAttribute: "Open profile", kAXDescriptionAttribute: "Open profile"], frame: shown,
                                      children: [FakeElement("AXStaticText", [kAXValueAttribute: "Alex"], frame: shown)])
            #expect(read(control, inside: "AXWebArea") == "Alex", "\(role)")
            #expect(read(control, inside: "AXGroup") == "", "\(role)")
        }
    }

    /// A long field that shows only its start gives what the window shows only that start, in the
    /// walk and in a row: its text scrolled out of view enters only the whole window's read.
    @Test func aLongFieldGivesWhatTheWindowShowsOnlyItsShownPart() throws {
        let shown = CGRect(x: 20, y: 40, width: 300, height: 20)
        let start = "Visible start."
        let value = start + String(repeating: "x", count: 20_001) + "OFFSCREEN_END"
        func field() -> FakeElement {
            FakeElement("AXTextArea", [kAXValueAttribute: value, "fieldShown": "\((start as NSString).length)"], frame: shown)
        }
        func read(_ element: FakeElement, whole: Bool) throws -> String {
            try walk(FakeElement("AXWindow", children: [FakeElement("AXWebArea", children: [element])]), whole: whole).renderedText()
        }
        #expect(try read(field(), whole: false) == "> " + start)
        #expect(try read(FakeElement("AXRow", children: [field()]), whole: false) == "| " + start)
        #expect(try read(field(), whole: true) == "> " + value)
        #expect(try read(FakeElement("AXRow", children: [field()]), whole: true).hasSuffix("OFFSCREEN_END"))
    }

    /// The editor in focus, as a field and as an editable page: what the window shows takes it by
    /// the text around its caret (bounded), as before; the whole window reads it whole, like the
    /// same editor out of focus, with its selection first and the text around its caret not read
    /// a second time. A focused editor on an excluded website, or holding one, refuses the window
    /// in both scopes, and a focused password field is never read.
    @Test(arguments: ["AXTextArea", "AXWebArea"])
    func aFocusedEditorIsReadWholeOnlyWithTheWholeWindow(role: String) throws {
        let opening = "Opening of the draft."
        let ending = "Words at the caret."
        let text = opening + String(repeating: " Ordinary body words.", count: 1500) + ending
        let native = text as NSString
        let frame = CGRect(x: 0, y: 0, width: 200, height: 100)
        func editor(selecting selected: Bool, host: String = "example.com", holding page: FakeElement? = nil) throws -> FakeElement {
            // The caret at the end, or the ending selected, read as the live tree reads it.
            let selection = selected ? native.range(of: ending) : NSRange(location: native.length, length: 0)
            let caret = try BoundedCaretSource.read(count: native.length, selection: selection) { native.substring(with: $0) as NSString }
            var attributes = [kAXValueAttribute: text, "editable": "yes", "host": host,
                              "caretBefore": caret.parts[0], "caretSelected": caret.parts[1], "caretAfter": caret.parts[2]]
            // The field shows its opening only.
            if role == "AXTextArea" { attributes["fieldShown"] = "\((opening as NSString).length)" }
            let children = role == "AXWebArea" ? [FakeElement("AXStaticText", [kAXValueAttribute: text], frame: frame)] : []
            return FakeElement(role, attributes, frame: frame, children: children + (page.map { [$0] } ?? []))
        }
        // The reply's text: what it shows, then the text around the caret it carries on its own.
        func reply(_ field: FakeElement, focused: Bool, whole: Bool, excluding exclusions: ScreenExclusions = ScreenExclusions()) -> JSON? {
            let window = FakeElement("AXWindow", frame: frame, children: [field])
            var start = ScreenContext(appName: "Synthetic editor")
            start.wholeWindow = whole
            return ScreenContextReader.gather(window: window, focused: focused ? field : nil, focusPath: focused ? [window] : [],
                                              in: FakeScreenTree(), excluding: exclusions, from: start)?.json(exclusions)
        }
        func read(_ field: FakeElement, focused: Bool, whole: Bool, excluding exclusions: ScreenExclusions = ScreenExclusions()) -> String? {
            reply(field, focused: focused, whole: whole, excluding: exclusions)?["renderedText"]?.string
        }
        func around(_ field: FakeElement, focused: Bool, whole: Bool) -> [String] {
            let json = reply(field, focused: focused, whole: whole)
            return ["textBeforeCaret", "selectedText", "textAfterCaret"].map { json?[$0]?.string ?? "<none>" }
        }
        func count(_ part: String, in read: String?) -> Int { (read ?? "").components(separatedBy: part).count - 1 }

        // What the window shows: the focused editor by the text around its caret, not its opening;
        // the same field out of focus by the part it shows.
        let shownFocused = read(try editor(selecting: false), focused: true, whole: false)
        #expect(count(ending, in: shownFocused) == 1)
        #expect(count(opening, in: shownFocused) == 0)
        let shownUnfocused = read(try editor(selecting: false), focused: false, whole: false)
        #expect(count(opening, in: shownUnfocused) == 1)
        #expect(count(ending, in: shownUnfocused) == (role == "AXWebArea" ? 1 : 0))
        // The whole window: the editor whole, in focus or not, each part once; in focus, the caret
        // block marks it, just before it.
        for focused in [true, false] {
            let whole = read(try editor(selecting: false), focused: focused, whole: true)
            #expect(count(opening, in: whole) == 1, "focused: \(focused)")
            #expect(count(ending, in: whole) == 1, "focused: \(focused)")
            #expect(count("» ‸", in: whole) == (focused ? 1 : 0), "focused: \(focused)")
        }
        let marked = try #require(read(try editor(selecting: false), focused: true, whole: true))
        let mark = try #require(marked.range(of: "» ‸")), opened = try #require(marked.range(of: opening))
        #expect(mark.lowerBound < opened.lowerBound)
        // A selection: in the caret block for what the window shows; for the whole window only in
        // the editor, read whole after the block that marks it.
        let shownSelected = read(try editor(selecting: true), focused: true, whole: false)
        #expect(count(ending, in: shownSelected) == 1)
        #expect(count(opening, in: shownSelected) == 0)
        let wholeSelected = read(try editor(selecting: true), focused: true, whole: true)
        #expect(count(opening, in: wholeSelected) == 1)
        #expect(count(ending, in: wholeSelected) == 1)
        #expect(count("» ‸", in: wholeSelected) == 1)
        // The caret's text rides on its own only with what the window shows; the whole window keeps
        // none of it, the selection included.
        let shownAround = around(try editor(selecting: false), focused: true, whole: false)
        #expect(count(ending, in: shownAround[0]) == 1 && shownAround[1].isEmpty && shownAround[2].isEmpty)
        #expect(around(try editor(selecting: true), focused: true, whole: false)[1] == ending)
        #expect(around(try editor(selecting: false), focused: true, whole: true) == ["", "", ""])
        #expect(around(try editor(selecting: true), focused: true, whole: true) == ["", "", ""])
        // An excluded website: the editor's own page, or one it holds, refuses the window in focus.
        let excluded = ScreenExclusions(hosts: ["blocked.example.com"])
        for whole in [true, false] {
            if role == "AXWebArea" {
                #expect(read(try editor(selecting: false, host: "blocked.example.com"), focused: true, whole: whole, excluding: excluded) == nil)
            }
            let holding = try editor(selecting: false, holding: FakeElement("AXWebArea", ["host": "blocked.example.com"], frame: frame))
            #expect(read(holding, focused: true, whole: whole, excluding: excluded) == nil, "whole: \(whole)")
        }
        // A password field in focus: nothing of it, in either scope.
        let password = FakeElement("AXTextField", [kAXValueAttribute: "Secret words", kAXSubroleAttribute: kAXSecureTextFieldSubrole,
                                                   "caretBefore": "Secret words", "caretSelected": "", "caretAfter": ""], frame: frame)
        for whole in [true, false] {
            let read = read(password, focused: true, whole: whole)
            #expect(count("Secret words", in: read) == 0 && count("» ‸", in: read) == 1, "whole: \(whole)")
        }
    }

    /// A secret selected inside the focused editor, whose label (`token=`) lies outside the
    /// selection, is never sent, in either read: what the window shows redacts the selection with
    /// the text around it; the whole window carries no copy of the selection at all and reads the
    /// editor whole, where the secret is redacted with its label. Public text is still read.
    @Test(arguments: ["AXTextArea", "AXWebArea"], [false, true])
    func aSecretSelectedInTheFocusedEditorIsNeverSent(role: String, whole: Bool) throws {
        let secret = "synthetic" + "Private123"
        let text = "Draft. token=" + secret + ". More."
        let native = text as NSString
        let caret = try BoundedCaretSource.read(count: native.length, selection: native.range(of: secret)) { native.substring(with: $0) as NSString }
        let frame = CGRect(x: 0, y: 0, width: 300, height: 100)
        let field = FakeElement(role, [kAXValueAttribute: text, "editable": "yes", "host": "example.com",
                                       "caretBefore": caret.parts[0], "caretSelected": caret.parts[1], "caretAfter": caret.parts[2]],
                                frame: frame, children: role == "AXWebArea" ? [FakeElement("AXStaticText", [kAXValueAttribute: text], frame: frame)] : [])
        let window = FakeElement("AXWindow", frame: frame, children: [field])
        var start = ScreenContext(appName: "Synthetic editor")
        start.wholeWindow = whole
        let context = try #require(ScreenContextReader.gather(window: window, focused: field, focusPath: [window], in: FakeScreenTree(),
                                                              excluding: ScreenExclusions(), from: start))
        let reply = context.json(ScreenExclusions())
        let rendered = try #require(reply["renderedText"]?.string)
        #expect(rendered.contains("Draft.") && rendered.contains("More."), "public text is still read")
        #expect(!String(decoding: try JSONEncoder().encode(reply), as: UTF8.self).contains(secret), "no part of the reply holds the secret")
        // What the window shows still says the selection held a secret (Edit refuses it); the whole
        // window has no selection.
        #expect(reply["selectedText"]?.string == (whole ? "" : "[redacted]"))
        #expect(reply["selectionRedacted"] == .bool(!whole))
    }

    /// The label outside a non-field selection still participates in the one shared redaction
    /// pass. Its neighboring text is private recognition context, not presented caret text.
    @Test(arguments: ["AXWebArea", "AXList", "AXRow"], [false, true])
    func aNonFieldSelectionIsRedactedWithItsPrivateContext(role: String, secret: Bool) throws {
        let selected = secret ? "synthetic" + "Private123" : "ordinary chosen words"
        let text = "Draft. " + (secret ? "token=" : "Read ") + selected + ". More."
        let native = text as NSString
        let caret = try BoundedCaretSource.read(count: native.length, selection: native.range(of: selected)) { native.substring(with: $0) as NSString }
        let frame = CGRect(x: 0, y: 0, width: 300, height: 100)
        let focus = FakeElement(role, ["host": "example.com", "caretBefore": caret.parts[0],
                                       "caretSelected": caret.parts[1], "caretAfter": caret.parts[2]],
                                frame: frame, children: [FakeElement("AXStaticText", [kAXValueAttribute: text], frame: frame)])
        let window = FakeElement("AXWindow", frame: frame, children: [focus])
        let context = try #require(ScreenContextReader.gather(window: window, focused: focus, focusPath: [window], in: FakeScreenTree(),
                                                              excluding: ScreenExclusions(), from: ScreenContext(appName: "Synthetic page")))
        let reply = context.json(ScreenExclusions())
        let rendered = try #require(reply["renderedText"]?.string)
        #expect(rendered.contains("Draft.") && rendered.contains("More."))
        #expect(reply["textBeforeCaret"]?.string == "" && reply["textAfterCaret"]?.string == "")
        #expect(reply["selectedText"]?.string == (secret ? "[redacted]" : selected))
        #expect(reply["selectionRedacted"] == .bool(secret))
        if secret {
            #expect(!String(decoding: try JSONEncoder().encode(reply), as: UTF8.self).contains(selected))
        }
    }

    @Test(arguments: [false, true])
    func aNonFieldPrivateSourceNeedsCompletePasswordAdmission(stopped: Bool) throws {
        let frame = CGRect(x: 0, y: 0, width: 300, height: 100)
        let password = FakeElement("AXTextField", [kAXSubroleAttribute: kAXSecureTextFieldSubrole, kAXValueAttribute: "synthetic protected value"], frame: frame)
        let focus = FakeElement("AXWebArea", ["host": "example.com", "caretBefore": "token=", "caretSelected": "syntheticPrivate123", "caretAfter": ""],
                                frame: frame, children: stopped ? [] : [password])
        let window = FakeElement("AXWindow", frame: frame, children: [focus])
        let context = try #require(ScreenContextReader.gather(window: window, focused: focus, focusPath: [window], in: FakeScreenTree(),
            excluding: ScreenExclusions(), from: ScreenContext(appName: "Synthetic page"), asked: { stopped }))
        #expect(focus.caretReads == 0 && password.textReads == 0)
        let reply = context.json
        #expect(reply["selectedText"]?.string == "" && reply["selectionRedacted"] == .bool(true))
    }

    /// In a row a titled control is read once, not again from its child text, and a thin field is
    /// left out beside a shown one; read beside it when the whole window is.
    @Test func rowTextReadsATitledControlOnceAndOnlyShownFields() throws {
        let shown = CGRect(x: 20, y: 40, width: 100, height: 20)
        func read(_ row: FakeElement, whole: Bool = false) -> String {
            try! walk(FakeElement("AXWindow", children: [FakeElement("AXWebArea", children: [row])]), whole: whole).renderedText()
        }
        let control = FakeElement("AXButton", [kAXTitleAttribute: "Alex Lee"], frame: shown, children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Alex"], frame: shown),
            FakeElement("AXStaticText", [kAXValueAttribute: "Lee"], frame: shown),
        ])
        #expect(read(FakeElement("AXRow", children: [control, FakeElement("AXStaticText", [kAXValueAttribute: "Draft"], frame: shown)]))
                == "| Alex Lee | Draft")
        let fields = FakeElement("AXRow", children: [
            FakeElement("AXTextField", [kAXValueAttribute: "Thin draft"], frame: CGRect(x: 20, y: 40, width: 100, height: 1)),
            FakeElement("AXTextField", [kAXValueAttribute: "Visible draft"], frame: shown),
        ])
        #expect(read(fields) == "| Visible draft")
        #expect(read(fields, whole: true) == "| Thin draft | Visible draft")
    }

    /// A row's text is gathered the way the walk reads: a web control's drawn title, never an icon's
    /// label; a thin piece only when the whole window is read; outside web content no control.
    @Test func rowTextReadsWebControlsAndLeavesHiddenTextOut() throws {
        func read(inside role: String, whole: Bool = false) -> String {
            let row = FakeElement("AXRow", frame: CGRect(x: 0, y: 100, width: 400, height: 30), children: [
                FakeElement("AXButton", [kAXTitleAttribute: "Sam Lee"], frame: CGRect(x: 0, y: 100, width: 80, height: 30)),
                FakeElement("AXStaticText", [kAXValueAttribute: "hidden"], frame: CGRect(x: 90, y: 100, width: 1, height: 1)),
                FakeElement("AXButton", [kAXDescriptionAttribute: "More actions"], frame: CGRect(x: 300, y: 100, width: 30, height: 30)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Draft"], frame: CGRect(x: 100, y: 100, width: 60, height: 30)),
            ])
            let area = FakeElement(role, frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [row])
            return try! walk(FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [area]), whole: whole).renderedText()
        }
        #expect(read(inside: "AXWebArea") == "| Sam Lee | Draft")
        #expect(read(inside: "AXGroup") == "| Draft")
        #expect(read(inside: "AXWebArea", whole: true) == "| Sam Lee | hidden | Draft")
        #expect(read(inside: "AXGroup", whole: true) == "| hidden | Draft")
    }

    /// A row's text view is part of its text: a native chat app's message is a text area in its
    /// table row, beside the time and the sender's name. One with nothing shown is left out, and read
    /// when the whole window is.
    @Test func rowTextReadsATextArea() throws {
        let shown = CGRect(x: 20, y: 40, width: 300, height: 32)
        let row = FakeElement("AXRow", frame: CGRect(x: 0, y: 30, width: 400, height: 60), children: [
            FakeElement("AXCell", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "10:15"], frame: CGRect(x: 340, y: 40, width: 30, height: 16)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Alex Lee"], frame: CGRect(x: 20, y: 30, width: 100, height: 18)),
                FakeElement("AXImage", frame: shown),
                FakeElement("AXTextArea", [kAXValueAttribute: "Lunch tomorrow at noon?"], frame: shown),
                FakeElement("AXTextArea", [kAXValueAttribute: "Thin draft"], frame: CGRect(x: 20, y: 40, width: 300, height: 1)),
            ]),
        ])
        let table = FakeElement("AXTable", frame: CGRect(x: 0, y: 0, width: 400, height: 600), children: [row])
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 400, height: 600), children: [table])
        #expect(try walk(window).renderedText() == "| 10:15 | Alex Lee | Lunch tomorrow at noon?")
        let text = try walk(window, whole: true).renderedText()
        #expect(text == "| 10:15 | Alex Lee | Lunch tomorrow at noon? | Thin draft")
    }

    /// A row's text is one block, read to its end however long a text view in it is, like the rest
    /// of the window (the screen's budget, not a row's own, ends it).
    @Test func aRowIsReadToItsEnd() throws {
        let long = String(repeating: "word ", count: 20_000) + "last"
        let row = FakeElement("AXRow", frame: CGRect(x: 0, y: 30, width: 400, height: 60), children: [
            FakeElement("AXCell", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "10:15"], frame: CGRect(x: 340, y: 40, width: 30, height: 16)),
                FakeElement("AXTextArea", [kAXValueAttribute: long], frame: CGRect(x: 20, y: 40, width: 300, height: 32)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Read"], frame: CGRect(x: 340, y: 60, width: 30, height: 16)),
            ]),
        ])
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 400, height: 600), children: [row])
        #expect(try walk(window).renderedText() == "| 10:15 | " + long + " | Read")
    }

    /// A field read whole (up to the screen's budget) is kept whole, alone or in a row.
    @Test func aFieldReadWholePastAWindowIsShown() throws {
        let window = try SharedContext.limit("sourceWindowBytes")
        let long = String(repeating: "word ", count: window / 5 + 1) + "last"
        for inRow in [false, true] {
            let field = FakeElement("AXTextArea", [kAXValueAttribute: long])
            let element = inRow ? FakeElement("AXRow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "Label"]), field]) : field
            let context = walk(FakeElement("AXWindow", children: [element]))
            #expect(!context.coreFailed)
            #expect(try context.renderedText() == (inRow ? "| Label | " : "> ") + long)
        }
    }

    /// A page of many short pieces is read whole: the screen's budget and the walk's node budget,
    /// not a count of blocks, end a read.
    @Test func aPageOfMoreThan5000PiecesIsReadWhole() throws {
        let pieces = (0...5_000).map { FakeElement("AXStaticText", [kAXValueAttribute: "Piece \($0)"]) }
        let context = walk(FakeElement("AXWindow", children: [FakeElement("AXWebArea", children: pieces)]))
        #expect(context.blocks.count == 5_001)
        let rendered = try context.renderedText()
        #expect(rendered.hasPrefix("Piece 0\n"))
        #expect(rendered.hasSuffix("\nPiece 5000"))
    }

    @Test func descendantRowsKeepCanonicalDuplicatesAndLargePieces() throws {
        func row(_ pieces: [String]) throws -> String {
            let children = pieces.map { FakeElement("AXStaticText", [kAXValueAttribute: $0]) }
            return try walk(FakeElement("AXWindow", children: [FakeElement("AXRow", children: children)])).renderedText()
        }
        #expect(try row([" é ", "e\u{301}", "\u{a0}next\u{a0}"]) == "| é | next")
        let family = "👨‍👩‍👧‍👦"
        #expect(try row([String(repeating: family, count: 1_001)]) == "| " + String(repeating: family, count: 1_001))
        #expect(try row([String(repeating: "e\u{301}", count: 20_001)]) == "| " + String(repeating: "e\u{301}", count: 20_001))
        // A piece past a window is read whole too.
        #expect(try row([String(repeating: family, count: 10_486)]) == "| " + String(repeating: family, count: 10_486))
    }

    @Test func sharedAcquisitionDecisionsPreventUnusedNativeValueReads() throws {
        let cell = FakeElement("AXStaticText", [kAXValueAttribute: "cell data"])
        let row = FakeElement("AXRow", [kAXTitleAttribute: "generic row"], children: [cell])
        #expect(try walk(FakeElement("AXWindow", children: [row])).renderedText() == "| cell data")
        #expect(row.textReads == 0 && cell.textReads > 0)
        let unused = FakeElement("AXStaticText", [kAXValueAttribute: "unused descendant"])
        let heading = FakeElement("AXHeading", [kAXTitleAttribute: "Title"], children: [unused])
        #expect(try walk(FakeElement("AXWindow", children: [heading])).renderedText() == "## Title")
        #expect(unused.textReads == 0)
        let late = FakeElement("AXStaticText", [kAXValueAttribute: "must not be read"])
        let screenBytes = try SharedContext.limit("screenBytes")
        let full = FakeElement("AXStaticText", [kAXValueAttribute: String(repeating: "x", count: screenBytes)])
        // A row that fills the screen's budget reads no more of itself; the read is cut there.
        let rendered = try walk(FakeElement("AXWindow", children: [FakeElement("AXRow", children: [full, late])])).renderedText()
        #expect(rendered.hasPrefix("| xxx") && rendered.allSatisfy { $0 == "x" || $0 == "|" || $0 == " " })
        #expect(late.textReads == 0)
    }

    @Test func sharedScreenBudgetStopsBeforeAnotherNativeValueAndPreservesCaret() throws {
        let screenBytes = try SharedContext.limit("screenBytes")
        let large = FakeElement("AXStaticText", [kAXValueAttribute: String(repeating: "x", count: screenBytes + 1)])
        let late = FakeElement("AXStaticText", [kAXValueAttribute: "must not be read"])
        let window = FakeElement("AXWindow", children: [large, late])
        var context = ScreenContext(appName: "Synthetic")
        context.textBeforeCaret = "left"; context.selectedText = "chosen"; context.textAfterCaret = "right"
        #expect(ScreenContextReader.walk(window, in: FakeScreenTree(), frame: nil, focused: nil, focusPath: [], excluding: ScreenExclusions(), into: &context))
        #expect(context.textBudgetFull && late.textReads == 0)
        let shown = context.json
        #expect(shown["selectedText"]?.string == "chosen")
        #expect(try context.renderedText().filter { $0 == "x" }.count <= screenBytes - "left‸chosen‸right".utf8.count)
    }

    @Test func summaryCarriesSizesNotText() throws {
        var context = ScreenContext(appName: "Example", bundleID: "com.example.app")
        context.windowTitle = "Private subject"
        context.textBeforeCaret = "secret words"
        context.append(.text, "confidential paragraph")
        #expect(!context.summary.contains("secret"))
        #expect(!context.summary.contains("confidential"))
        #expect(!context.summary.contains("Private"))
        #expect(!context.summary.contains("Example") && !context.summary.contains("com.example.app"))
        #expect(context.summary.contains("caret 12/0/0 chars"))
    }

    /// A read timed across a wall clock set back still gives its reply, timed at zero, never hidden.
    @Test func aClockSetBackDuringTheReadDoesNotHideIt() throws {
        var context = ScreenContext(appName: "Example", bundleID: "com.example.app")
        context.append(.text, "visible paragraph")
        context.seconds = -0.01
        #expect(try context.renderedText() == "visible paragraph")
        #expect(context.summary.contains(" 0 ms"))
    }

    /// The debug log file gets every field, the text around the caret and the visible text as the
    /// prompts receive it (ADR-DESK-015).
    @Test func aScreenReadLogsEveryField() throws {
        var context = ScreenContext(appName: "Example", bundleID: "com.example.app")
        context.windowTitle = "Inbox"
        context.host = "mail.example.com"
        context.terminalProgram = "vim"
        context.focusedRole = "AXTextArea"
        context.textBeforeCaret = "Dear Alex,"
        context.selectedText = "draft"
        context.textAfterCaret = "Thanks"
        context.stoppedEarly = "node budget"
        context.append(.heading, "Inbox")
        context.appendCaret()

        let text = try context.logDescription

        #expect(text.hasPrefix("app Example (com.example.app), window title Inbox, host mail.example.com, terminal program vim, focused AXTextArea, stopped: node budget\n"))
        #expect(text.contains("--- text before the caret ---\nDear Alex,\n"))
        #expect(text.contains("--- selected text ---\ndraft\n"))
        #expect(text.contains("--- text after the caret ---\nThanks\n"))
        #expect(try text.hasSuffix("--- visible text ---\n" + context.renderedText()))
    }

    /// What the app receives for a screen read: every field it reads, unknown ones as null, the text
    /// already rendered, and the two log forms.
    @Test func theAppReceivesEveryFieldAndTheRenderedText() throws {
        var context = ScreenContext(appName: "Example", bundleID: "com.example.app")
        context.windowTitle = "Inbox"
        context.textBeforeCaret = "Note: "
        context.selectedText = "Ship it."
        context.append(.heading, "Agenda")
        context.appendCaret()

        let json = context.json

        #expect(json["appName"]?.string == "Example")
        #expect(json["bundleID"]?.string == "com.example.app")
        #expect(json["windowTitle"]?.string == "Inbox")
        #expect(json["host"] == .null)
        #expect(json["terminalProgram"] == .null)
        #expect(json["focusedRole"] == .null)
        #expect(json["textBeforeCaret"]?.string == "Note: ")
        #expect(json["selectedText"]?.string == "Ship it.")
        #expect(json["textAfterCaret"]?.string == "")
        #expect(json["renderedText"]?.string == "## Agenda\n» Note: ‸Ship it.‸")
        #expect(json["summary"]?.string == "2 blocks (1 headings, 0 rows, 0 links, 0 fields, caret placed true), 28 chars, title 5 chars, caret 6/8/0 chars, 0 nodes, 0 ms")
        #expect(json["logDescription"]?.string?.hasPrefix("app Example (com.example.app), window title Inbox, host -, terminal program -, focused -\n--- text before the caret ---\nNote: \n") == true)
    }

    // MARK: Terminal visible lines

    @Test func firstVisibleLineFindsTheWindowTop() throws {
        // 1000 lines of 16 pt; the window's top edge sits at line 900.
        let top = ScreenContext.firstVisibleLine(lineCount: 1000, windowTop: 900 * 16) { CGFloat($0 * 16) }
        #expect(top == 900)
    }

    @Test func firstVisibleLineIsNilWhenEveryLineIsAbove() throws {
        #expect(ScreenContext.firstVisibleLine(lineCount: 10, windowTop: 1000) { CGFloat($0) } == nil)
    }

    @Test func firstVisibleLineGivesUpWhenALineHasNoBounds() throws {
        #expect(ScreenContext.firstVisibleLine(lineCount: 10, windowTop: 5) { _ in nil } == nil)
    }
}

/// An element of a fake Accessibility tree for `ScreenContextReader.walk`.
final class FakeElement {
    let role: String
    let attributes: [String: String]
    let frame: CGRect?
    let children: [FakeElement]
    var textReads = 0
    var caretReads = 0
    /// The boxes of its text's first and last characters, as the app gives them.
    var ends: [CGRect]?

    init(_ role: String, _ attributes: [String: String] = [:], frame: CGRect? = nil, children: [FakeElement] = []) {
        self.role = role
        self.attributes = attributes
        self.frame = frame
        self.children = children
    }
}

struct FakeScreenTree: ScreenTree {
    func children(of element: FakeElement) -> [FakeElement] { element.children }
    func frame(of element: FakeElement) -> CGRect? { element.frame }
    func ends(of element: FakeElement) -> [CGRect]? { element.ends }
    func string(_ element: FakeElement, _ name: String) -> String? {
        if name == kAXValueAttribute || name == kAXTitleAttribute || name == kAXDescriptionAttribute { element.textReads += 1 }
        return name == kAXRoleAttribute ? element.role : element.attributes[name]
    }
    /// "hostUnknown" stands for an app that failed to give the page's address.
    func page(of webArea: FakeElement) -> PageHost {
        webArea.attributes["hostUnknown"] != nil ? .unknown : webArea.attributes["host"].map(PageHost.host) ?? .noHost
    }
    /// "fieldShown" (a number of characters) stands for a field that shows only its start: it is
    /// read as the live tree reads one (`BoundedFieldReader`), for the read's scope.
    func fieldSource(of element: FakeElement, windowFrame: CGRect?, wholeWindow: Bool) -> [String]? {
        element.textReads += 1
        if let shown = element.attributes["fieldShown"].flatMap(Int.init), let value = element.attributes[kAXValueAttribute].map({ $0 as NSString }) {
            return try? BoundedFieldReader.read(count: value.length, wholeWindow: wholeWindow, whole: { value },
                range: { value.substring(with: $0) as NSString }, visible: { _ in NSRange(location: 0, length: shown) }, valid: { true })?.parts
        }
        return element.attributes[kAXValueAttribute].map { [element.attributes["fieldBefore"] ?? "", $0, element.attributes["fieldAfter"] ?? ""] }
    }
    func caretWindow(of element: FakeElement) -> SharedContext.CaretWindow? {
        element.caretReads += 1
        guard let before = element.attributes["caretBefore"], let selected = element.attributes["caretSelected"],
              let after = element.attributes["caretAfter"] else { return nil }
        return SharedContext.CaretWindow(parts: [before, selected, after], selectionUnavailable: element.attributes["selectionUnavailable"] != nil)
    }
    func isSame(_ first: FakeElement, _ second: FakeElement) -> Bool { first === second }
    /// "editable" stands for an element whose text the app lets be changed.
    func isEditable(_ element: FakeElement) -> Bool { element.attributes["editable"] != nil }
}

/// A fake tree that is asked to stop once a given element's children are looked through (a
/// field's look for a framed page), and reports each attribute read.
final class StopTree: ScreenTree {
    private let base = FakeScreenTree()
    private let stopsAt: FakeElement?
    var onString: ((FakeElement, String) -> Void)?
    private(set) var asked = false
    private(set) var looks = 0

    init(stopsAt: FakeElement?) { self.stopsAt = stopsAt }

    func children(of element: FakeElement) -> [FakeElement] {
        if let stopsAt, element === stopsAt { looks += 1; asked = true }
        return base.children(of: element)
    }
    func frame(of element: FakeElement) -> CGRect? { base.frame(of: element) }
    func ends(of element: FakeElement) -> [CGRect]? { base.ends(of: element) }
    func string(_ element: FakeElement, _ name: String) -> String? {
        onString?(element, name)
        return base.string(element, name)
    }
    func page(of webArea: FakeElement) -> PageHost { base.page(of: webArea) }
    func fieldSource(of element: FakeElement, windowFrame: CGRect?, wholeWindow: Bool) -> [String]? { base.fieldSource(of: element, windowFrame: windowFrame, wholeWindow: wholeWindow) }
    func caretWindow(of element: FakeElement) -> SharedContext.CaretWindow? { base.caretWindow(of: element) }
    func isSame(_ first: FakeElement, _ second: FakeElement) -> Bool { first === second }
    func isEditable(_ element: FakeElement) -> Bool { base.isEditable(element) }
}

// Verify separators through the real renderer without retaining native geometry policy.
private extension ScreenContext {
    static func separator(between first: Block, and second: Block) -> String {
        func rendered(_ blocks: [Block]) -> String {
            var context = ScreenContext(appName: "Synthetic")
            context.blocks = blocks
            return try! context.renderedText()
        }
        let a = rendered([first]), b = rendered([second]), both = rendered([first, second])
        return String(both.dropFirst(a.count).dropLast(b.count))
    }
}
