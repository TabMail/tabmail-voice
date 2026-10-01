// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import CoreGraphics
import Foundation
import os
import Testing
@testable import VoiceMacOSKit

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

    // MARK: Layout

    /// A Slack message as its Accessibility frames report it (measured 2026-09-26): the author
    /// button and the time link share a line, the text below wraps onto a second line where an
    /// emoji splits it, and the thread pane to the right starts back at the window's top.
    @Test func renderedTextLaysTextOutInLinesAsOnScreen() {
        var context = ScreenContext(appName: "Slack")
        context.append(.text, "Alex", frame: CGRect(x: 868, y: 874, width: 52, height: 25))
        context.append(.link, "Today at 9:20:09 AM", frame: CGRect(x: 928, y: 880, width: 51, height: 16))
        context.append(.text, "The draft is ready for review", frame: CGRect(x: 868, y: 900, width: 590, height: 45))
        context.append(.text, "Let me know what you think", frame: CGRect(x: 940, y: 925, width: 278, height: 20))
        context.append(.text, "10 replies", frame: CGRect(x: 933, y: 955, width: 63, height: 21))
        context.append(.heading, "Thread", frame: CGRect(x: 1510, y: 160, width: 80, height: 24))
        context.append(.text, "Sam Lee", frame: CGRect(x: 1560, y: 200, width: 124, height: 25))
        #expect(context.renderedText() == """
            Alex [Today at 9:20:09 AM]
            The draft is ready for review Let me know what you think
            10 replies

            ## Thread
            Sam Lee
            """)
    }

    /// Only text and links flow: a heading, row, field or the caret block starts its own line even
    /// beside other text, and so does text to the left of the previous piece.
    @Test func onlyTextAndLinksShareALine() {
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
    @Test func aSliverOfOverlapIsNotOneLine() {
        let first = ScreenContext.Block(kind: .text, text: "a", frame: CGRect(x: 0, y: 100, width: 50, height: 20))
        func second(y: CGFloat) -> ScreenContext.Block { .init(kind: .text, text: "b", frame: CGRect(x: 60, y: y, width: 50, height: 20)) }
        #expect(ScreenContext.separator(between: first, and: second(y: 110)) == " ")
        #expect(ScreenContext.separator(between: first, and: second(y: 111)) == "\n")
        #expect(ScreenContext.separator(between: first, and: second(y: 120)) == "\n")
    }

    /// Text wholly above the previous piece is the next pane or column: a blank line between.
    @Test func aJumpBackUpLeavesABlankLine() {
        let first = ScreenContext.Block(kind: .text, text: "a", frame: CGRect(x: 0, y: 500, width: 50, height: 20))
        func second(y: CGFloat) -> ScreenContext.Block { .init(kind: .text, text: "b", frame: CGRect(x: 600, y: y, width: 50, height: 20)) }
        #expect(ScreenContext.separator(between: first, and: second(y: 100)) == "\n\n")
        #expect(ScreenContext.separator(between: first, and: second(y: 480)) == "\n\n")
        #expect(ScreenContext.separator(between: first, and: second(y: 485)) == "\n")
    }

    @Test func withoutFramesEveryPieceHasItsOwnLine() {
        let framed = ScreenContext.Block(kind: .text, text: "a", frame: CGRect(x: 0, y: 0, width: 50, height: 20))
        let unframed = ScreenContext.Block(kind: .text, text: "b")
        #expect(ScreenContext.separator(between: framed, and: unframed) == "\n")
        #expect(ScreenContext.separator(between: unframed, and: framed) == "\n")
    }

    @Test func caretBlockKeepsItsFrame() {
        var context = ScreenContext(appName: "Example")
        let frame = CGRect(x: 10, y: 20, width: 300, height: 40)
        context.appendCaret(frame: frame)
        #expect(context.blocks.first?.frame == frame)
    }

    // MARK: What is read

    /// Web apps keep hidden text in boxes at most a point thin (frames measured in Slack and
    /// Chrome 2026-09-26); a 0×0 frame says nothing and counts as shown.
    @Test func textInAPointThinBoxIsHidden() {
        #expect(!ScreenContext.isShown(CGRect(x: 945, y: 234, width: 147, height: 1)))  // scrolled out of Slack's list
        #expect(!ScreenContext.isShown(CGRect(x: 2099, y: 278, width: 0, height: 1)))   // scrolled out in Chrome
        #expect(!ScreenContext.isShown(CGRect(x: 1477, y: 774, width: 1, height: 36)))  // hover-only action
        #expect(!ScreenContext.isShown(CGRect(x: 797, y: 146, width: 1, height: 1)))    // screen-reader-only
        #expect(ScreenContext.isShown(CGRect(x: 868, y: 874, width: 52, height: 25)))
        #expect(ScreenContext.isShown(CGRect(x: 0, y: 0, width: 2, height: 2)))
        #expect(ScreenContext.isShown(.zero))
    }

    /// In web content controls and toolbars are read; in native apps they stay skipped, and
    /// images, menus and scroll bars everywhere.
    @Test func controlsAndToolbarsAreReadOnlyInWebContent() {
        for role in ["AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXToolbar"] {
            #expect(!ScreenContextReader.isSkipped(role, inWeb: true))
            #expect(ScreenContextReader.isSkipped(role, inWeb: false))
        }
        for role in ["AXImage", "AXMenu", "AXMenuItem", "AXMenuBar", "AXScrollBar", "AXSlider", "AXIncrementor"] {
            #expect(ScreenContextReader.isSkipped(role, inWeb: true))
        }
        #expect(!ScreenContextReader.isSkipped("AXStaticText", inWeb: false))
    }

    /// A web control's title is text drawn in it only when it has no description: Slack's message
    /// author has a title alone; an icon button a description (Slack) or both (an Electron chat
    /// app's "Copy").
    @Test func aControlsTitleIsItsTextOnlyWithoutADescription() {
        #expect(ScreenContextReader.drawnTitle(title: "Alex", description: nil) == "Alex")
        #expect(ScreenContextReader.drawnTitle(title: "10 replies", description: " ") == "10 replies")
        #expect(ScreenContextReader.drawnTitle(title: nil, description: "Add reaction…") == nil)
        #expect(ScreenContextReader.drawnTitle(title: "Copy", description: "Copy") == nil)
        #expect(ScreenContextReader.drawnTitle(title: "  ", description: nil) == nil)
    }

    @Test func framesWithoutASizeHaveTheirOwnLines() {
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

    private func walk(_ window: FakeElement, focused: FakeElement? = nil, focusPath: [FakeElement] = []) -> ScreenContext {
        var context = ScreenContext(appName: "Example")
        ScreenContextReader.walk(window, in: FakeScreenTree(), frame: window.frame, focused: focused,
                                 focusPath: focusPath, started: Date(), into: &context)
        return context
    }

    /// Who wrote a message reaches the prompt: the author and time on one line, the message below,
    /// with neither scrolled-out text nor icon labels, and the caret block after.
    @Test func walkReadsAWebChatAsItsScreenShowsIt() {
        let slack = slackWindow()
        let context = walk(slack.window, focused: slack.focused, focusPath: slack.focusPath)
        #expect(context.renderedText() == "Alex Lee [Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
        #expect(context.blocks.last?.frame == slack.focused.frame)
    }

    /// Outside web content a control's title may be an icon's label, so controls stay skipped.
    @Test func walkSkipsControlsOutsideWebContent() {
        let native = slackWindow(webArea: "AXGroup")
        let context = walk(native.window, focused: native.focused, focusPath: native.focusPath)
        #expect(context.renderedText() == "[Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
    }

    /// A heading, link, row or field in a point-thin box shows nothing, like text; the one shown
    /// piece beside them proves the walk reached them.
    @Test func walkLeavesOutEveryKindOfHiddenBlock() {
        let thin = CGRect(x: 10, y: 50, width: 300, height: 1)
        let area = FakeElement("AXWebArea", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [
            FakeElement("AXHeading", [kAXTitleAttribute: "Hidden heading"], frame: thin),
            FakeElement("AXLink", [kAXDescriptionAttribute: "Hidden link"], frame: thin),
            FakeElement("AXRow", [kAXDescriptionAttribute: "Hidden row"], frame: thin),
            FakeElement("AXTextField", [kAXValueAttribute: "Hidden field"], frame: thin),
            FakeElement("AXStaticText", [kAXValueAttribute: "Shown"], frame: CGRect(x: 10, y: 100, width: 60, height: 20)),
        ])
        let context = walk(FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [area]))
        #expect(context.renderedText() == "Shown")
    }

    /// A password field is never read, whether or not the app hides its value: not in the window, not
    /// in a row, not its child text, not when it is a web control.
    @Test func walkNeverReadsAPasswordField() {
        let secure = [kAXSubroleAttribute: kAXSecureTextFieldSubrole as String, kAXValueAttribute: "placeholder-secret"]
        let area = FakeElement("AXWebArea", children: [
            FakeElement("AXTextField", secure, children: [FakeElement("AXStaticText", [kAXValueAttribute: "placeholder-secret"])]),
            FakeElement("AXRow", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "Sign in"]),
                FakeElement("AXTextField", secure),
            ]),
            FakeElement("AXButton", secure.merging([kAXTitleAttribute: "placeholder-secret"]) { $1 }),
        ])
        let window = FakeElement("AXWindow", children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Account"]),
            FakeElement("AXTextField", secure),
            FakeElement("AXTextArea", secure),
            area,
        ])
        let text = walk(window).renderedText()
        #expect(text == "Account\n| Sign in")
        #expect(!text.contains("placeholder-secret"))
    }

    /// The focused field's text is read around the caret, unless it is a password field; the caret
    /// still marks its place.
    @Test func theFocusedPasswordFieldIsNeverRead() {
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
        ScreenContextReader.walk(window, in: FakeScreenTree(), frame: nil, focused: field, focusPath: [], started: Date(), into: &context)
        #expect(context.textBeforeCaret.isEmpty && context.selectedText.isEmpty && context.textAfterCaret.isEmpty)
        #expect(context.renderedText() == "Password\n» ‸")
        #expect(!context.logDescription.contains("placeholder"))
    }

    /// An app that reports no frames is read in full, as before frames were read: no frame counts
    /// as shown, in the walk and in a row's text.
    @Test func walkReadsElementsWithoutFrames() {
        let row = FakeElement("AXRow", children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Cell one"]),
            FakeElement("AXStaticText", [kAXValueAttribute: "Cell two"]),
        ])
        let window = FakeElement("AXWindow", children: [FakeElement("AXStaticText", [kAXValueAttribute: "Plain"]), row])
        #expect(walk(window).renderedText() == "Plain\n| Cell one | Cell two")
    }

    /// In web content a toolbar's text is read (a chat's header with the conversation's name), and
    /// a control with a screen-reader label still shows its drawn child text; in native apps both
    /// stay skipped.
    @Test func webToolbarsAndLabeledControlsKeepTheirShownText() {
        let shown = CGRect(x: 20, y: 40, width: 100, height: 20)
        let thin = CGRect(x: 20, y: 40, width: 100, height: 1)
        func read(_ element: FakeElement, inside role: String) -> String {
            walk(FakeElement("AXWindow", children: [FakeElement(role, children: [element])])).renderedText()
        }
        let toolbar = FakeElement("AXToolbar", children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Project chat"], frame: shown),
            FakeElement("AXStaticText", [kAXValueAttribute: "Hidden label"], frame: thin),
        ])
        #expect(read(toolbar, inside: "AXWebArea") == "Project chat")
        #expect(read(toolbar, inside: "AXGroup") == "")
        for role in ["AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton"] {
            let control = FakeElement(role, [kAXTitleAttribute: "Open profile", kAXDescriptionAttribute: "Open profile"], frame: shown,
                                      children: [FakeElement("AXStaticText", [kAXValueAttribute: "Alex"], frame: shown)])
            #expect(read(control, inside: "AXWebArea") == "Alex", "\(role)")
            #expect(read(control, inside: "AXGroup") == "", "\(role)")
        }
    }

    /// In a row a titled control is read once, not again from its child text, and a thin field is
    /// left out beside a shown one.
    @Test func rowTextReadsATitledControlOnceAndOnlyShownFields() {
        let shown = CGRect(x: 20, y: 40, width: 100, height: 20)
        func read(_ row: FakeElement) -> String {
            walk(FakeElement("AXWindow", children: [FakeElement("AXWebArea", children: [row])])).renderedText()
        }
        let control = FakeElement("AXButton", [kAXTitleAttribute: "Alex Lee"], frame: shown, children: [
            FakeElement("AXStaticText", [kAXValueAttribute: "Alex"], frame: shown),
            FakeElement("AXStaticText", [kAXValueAttribute: "Lee"], frame: shown),
        ])
        #expect(read(FakeElement("AXRow", children: [control, FakeElement("AXStaticText", [kAXValueAttribute: "Draft"], frame: shown)]))
                == "| Alex Lee | Draft")
        #expect(read(FakeElement("AXRow", children: [
            FakeElement("AXTextField", [kAXValueAttribute: "Hidden draft"], frame: CGRect(x: 20, y: 40, width: 100, height: 1)),
            FakeElement("AXTextField", [kAXValueAttribute: "Visible draft"], frame: shown),
        ])) == "| Visible draft")
    }

    /// A row's text is gathered the way the walk reads: a web control's drawn title, never a
    /// hidden piece or an icon's label; outside web content no control.
    @Test func rowTextReadsWebControlsAndLeavesHiddenTextOut() {
        func read(inside role: String) -> String {
            let row = FakeElement("AXRow", frame: CGRect(x: 0, y: 100, width: 400, height: 30), children: [
                FakeElement("AXButton", [kAXTitleAttribute: "Sam Lee"], frame: CGRect(x: 0, y: 100, width: 80, height: 30)),
                FakeElement("AXStaticText", [kAXValueAttribute: "hidden"], frame: CGRect(x: 90, y: 100, width: 1, height: 1)),
                FakeElement("AXButton", [kAXDescriptionAttribute: "More actions"], frame: CGRect(x: 300, y: 100, width: 30, height: 30)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Draft"], frame: CGRect(x: 100, y: 100, width: 60, height: 30)),
            ])
            let area = FakeElement(role, frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [row])
            return walk(FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [area])).renderedText()
        }
        #expect(read(inside: "AXWebArea") == "| Sam Lee | Draft")
        #expect(read(inside: "AXGroup") == "| Draft")
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

    /// The debug log file gets every field, the text around the caret and the visible text as the
    /// prompts receive it (ADR-DESK-015).
    @Test func aScreenReadLogsEveryField() {
        var context = ScreenContext(appName: "Example", bundleID: "com.example.app")
        context.windowTitle = "Inbox"
        context.host = "mail.example.com"
        context.terminalProgram = "vim"
        context.focusedRole = "AXTextArea"
        context.textBeforeCaret = "Dear Alex,"
        context.selectedText = "draft"
        context.textAfterCaret = "Thanks"
        context.stoppedEarly = "time budget"
        context.append(.heading, "Inbox")
        context.appendCaret()

        let text = context.logDescription

        #expect(text.hasPrefix("app Example (com.example.app), window title Inbox, host mail.example.com, terminal program vim, focused AXTextArea, stopped: time budget\n"))
        #expect(text.contains("--- text before the caret ---\nDear Alex,\n"))
        #expect(text.contains("--- selected text ---\ndraft\n"))
        #expect(text.contains("--- text after the caret ---\nThanks\n"))
        #expect(text.hasSuffix("--- visible text ---\n" + context.renderedText()))
    }

    /// What the app receives for a screen read: every field it reads, unknown ones as null, the text
    /// already rendered, and the two log forms.
    @Test func theAppReceivesEveryFieldAndTheRenderedText() {
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
        #expect(json["summary"]?.string == context.summary)
        #expect(json["logDescription"]?.string == context.logDescription)
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

/// The helper commands (tmux, ps) run while the context is read: a command that never finishes
/// must not leave the read, or a process, hanging.
struct ScreenContextCommandTests {
    @Test func returnsTheOutputOfACommandThatFinishes() {
        #expect(ScreenContextReader.run("/bin/echo", ["pane text"]) == "pane text\n")
    }

    /// More than a pipeful of mixed UTF-8 must come back whole, in order, with no lost reads.
    @Test func returnsEveryByteOfOutputLargerThanThePipeBuffer() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("tabmail-tests-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: file) }
        let expected = String(repeating: "Aé😀", count: 28_571) + "END"
        try Data(expected.utf8).write(to: file)

        let text = try #require(Self.runWithWatchdog(#"exec /bin/cat "$1""#, arguments: [file.path], timeout: 30))

        #expect(text.utf8.count == 200_000)
        #expect(text == expected)
    }

    /// EOF can precede exit. A successful command is still awaited, but output and exit share
    /// one deadline; closing output does not buy a slow command another full timeout.
    @Test(arguments: [
        (4, 1, 30.0, Optional("pane text\n")),
        (8, 8, 10.0, nil),
    ])
    func waitsForExitOnlyWithinTheOriginalDeadline(beforeEOF: Int, afterEOF: Int, timeout: Double, expected: String?) {
        let script = "echo 'pane text'; sleep \(beforeEOF); exec >&-; exec sleep \(afterEOF)"
        #expect(Self.runWithWatchdog(script, timeout: timeout) == expected)
    }

    @Test func stopsACommandThatDoesNotFinish() throws {
        let pid = try #require(Self.pidOfACommandStoppedAtTheDeadline("exec sleep 30"))
        #expect(Self.exits(pid))
    }

    /// Output ends (EOF) but the command keeps running: it is stopped at the deadline all the same.
    @Test func stopsACommandThatClosesItsOutputAndKeepsRunning() throws {
        let pid = try #require(Self.pidOfACommandStoppedAtTheDeadline("exec >&-; exec sleep 30"))
        #expect(Self.exits(pid))
    }

    /// A stopped tmux server holds the client's output open, so it never ends even after the client
    /// exits. Here a background child holds it the same way after the shell exits.
    @Test func givesUpOnOutputThatNeverEnds() {
        let clock = ContinuousClock()
        let started = clock.now
        #expect(ScreenContextReader.run("/bin/sh", ["-c", "sleep 5 & echo partial"], timeout: 0.2) == nil)
        #expect(clock.now - started < .seconds(2))
    }

    /// Output still flowing at the deadline: the read stops there instead of reading on forever.
    /// Whether a read is mid-stream at the deadline depends on scheduling, so this runs many short
    /// reads. Each runs on its own thread, and a read that hasn't returned in time has its command
    /// killed, so a failure can't hang the suite.
    @Test func stopsACommandWhoseOutputIsStillFlowingAtTheDeadline() {
        for _ in 0..<40 {
            let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("tabmail-tests-\(UUID().uuidString).pid")
            defer { try? FileManager.default.removeItem(at: pidFile) }
            let output = OSAllocatedUnfairLock<String?>(initialState: "not returned")
            let returned = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                let text = ScreenContextReader.run("/bin/sh", ["-c", #"echo $$ > "$0"; while :; do echo x; done"#, pidFile.path], timeout: 0.05)
                output.withLock { $0 = text }
                returned.signal()
            }

            let inTime = returned.wait(timeout: .now() + 1) == .success
            // No pid file: the shell was stopped before its first command, so nothing was flowing.
            let pid = Self.pid(in: pidFile)
            if !inTime, let pid {
                kill(pid, SIGKILL)
                _ = returned.wait(timeout: .now() + 5)
            }
            #expect(inTime)
            #expect(output.withLock { $0 } == nil)
            if let pid { #expect(Self.exits(pid)) }
            guard inTime else { return }
        }
    }

    /// Runs independently of the test thread, with enough slack for a loaded runner. A broken
    /// read or exit wait fails the test and has its shell stopped instead of hanging the suite.
    private static func runWithWatchdog(_ script: String, arguments: [String] = [], timeout: Double) -> String? {
        let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("tabmail-tests-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }
        let output = OSAllocatedUnfairLock<String?>(initialState: nil)
        let returned = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let text = ScreenContextReader.run("/bin/sh", ["-c", #"echo $$ > "$0"; "# + script, pidFile.path] + arguments, timeout: timeout)
            output.withLock { $0 = text }
            returned.signal()
        }

        let inTime = returned.wait(timeout: .now() + timeout + 15) == .success
        if !inTime {
            if let pid = pid(in: pidFile) { kill(pid, SIGKILL) }
            _ = returned.wait(timeout: .now() + 5)
        }
        #expect(inTime)
        return output.withLock { $0 }
    }

    /// Runs `script` under a deadline, which must stop it, until one run got as far as writing its
    /// shell's pid, and returns that pid. On a loaded runner starting the shell can take longer than a
    /// short deadline, which then stops it before its first command; such a run still must end in time,
    /// but shows nothing about stopping a running command, so it is tried again with twice the deadline
    /// (0.2 s up to 3.2 s).
    private static func pidOfACommandStoppedAtTheDeadline(_ script: String) -> pid_t? {
        var timeout = 0.2
        for _ in 0..<5 {
            let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("tabmail-tests-\(UUID().uuidString).pid")
            defer { try? FileManager.default.removeItem(at: pidFile) }
            let clock = ContinuousClock()
            let started = clock.now
            #expect(ScreenContextReader.run("/bin/sh", ["-c", #"echo $$ > "$0"; "# + script, pidFile.path], timeout: timeout) == nil)
            #expect(clock.now - started < .seconds(timeout + 2))
            if let pid = pid(in: pidFile) { return pid }
            timeout *= 2
        }
        return nil
    }

    /// The process id a test command wrote to `file`, if it got that far.
    private static func pid(in file: URL) -> pid_t? {
        (try? String(contentsOf: file, encoding: .utf8)).flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
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

/// An element of a fake Accessibility tree for `ScreenContextReader.walk`.
final class FakeElement {
    let role: String
    let attributes: [String: String]
    let frame: CGRect?
    let children: [FakeElement]

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
    func string(_ element: FakeElement, _ name: String) -> String? { name == kAXRoleAttribute ? element.role : element.attributes[name] }
    func host(of webArea: FakeElement) -> String? { webArea.attributes["host"] }
    func fieldText(of element: FakeElement, windowFrame: CGRect?) -> String? { element.attributes[kAXValueAttribute] }
    func caretWindow(of element: FakeElement) -> (String, String, String)? {
        guard let before = element.attributes["caretBefore"], let selected = element.attributes["caretSelected"],
              let after = element.attributes["caretAfter"] else { return nil }
        return (before, selected, after)
    }
    func isSame(_ first: FakeElement, _ second: FakeElement) -> Bool { first === second }
}
