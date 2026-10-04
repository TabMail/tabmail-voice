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

    @Test func caretWindowSplitsAroundTheSelection() throws {
        let window = ScreenContext.caretWindow(in: "Hello there world", selection: NSRange(location: 6, length: 5), maxChars: 100)
        #expect(window.before == "Hello ")
        #expect(window.selected == "there")
        #expect(window.after == " world")
    }

    @Test func caretWindowKeepsOnlyTheNearestCharacters() throws {
        let window = ScreenContext.caretWindow(in: "abcdefghij", selection: NSRange(location: 5, length: 0), maxChars: 2)
        #expect(window.before == "de")
        #expect(window.selected == "")
        #expect(window.after == "fg")
    }

    /// Accessibility reports ranges past the end at times (a stale caret); clamp, don't crash.
    @Test func caretWindowClampsARangePastTheEnd() throws {
        let window = ScreenContext.caretWindow(in: "abc", selection: NSRange(location: 10, length: 4), maxChars: 5)
        #expect(window.before == "abc")
        #expect(window.selected == "")
        #expect(window.after == "")
    }

    /// Ranges count UTF-16 units; a cut through an emoji's surrogate pair keeps the whole emoji.
    @Test func caretWindowNeverSplitsACharacter() throws {
        let text = "a😀b" // "😀" is two UTF-16 units: a=0, 😀=1…2, b=3
        let window = ScreenContext.caretWindow(in: text, selection: NSRange(location: 3, length: 0), maxChars: 1)
        #expect(window.before == "😀")
        #expect(window.after == "b")
    }

    // MARK: Visible text

    @Test func appendSkipsBlanksAndRepeats() throws {
        var context = ScreenContext(appName: "Example")
        context.append(.link, "Inbox")
        context.append(.text, "Inbox")
        context.append(.text, "  ")
        context.append(.text, " Drafts\n")
        #expect(context.blocks == [.init(kind: .link, text: "Inbox"), .init(kind: .text, text: "Drafts")])
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
    /// Chrome 2026-09-26); a 0×0 frame says nothing and counts as shown.
    @Test func textInAPointThinBoxIsHidden() throws {
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
    @Test func controlsAndToolbarsAreReadOnlyInWebContent() throws {
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

    private func walk(_ window: FakeElement, focused: FakeElement? = nil, focusPath: [FakeElement] = []) -> ScreenContext {
        var context = ScreenContext(appName: "Example")
        let read = ScreenContextReader.walk(window, in: FakeScreenTree(), frame: window.frame, focused: focused,
                                            focusPath: focusPath, excluding: ScreenExclusions(), started: Date(), into: &context)
        #expect(read)
        return context
    }

    /// Who wrote a message reaches the prompt: the author and time on one line, the message below,
    /// with neither scrolled-out text nor icon labels, and the caret block after.
    @Test func walkReadsAWebChatAsItsScreenShowsIt() throws {
        let slack = slackWindow()
        let context = walk(slack.window, focused: slack.focused, focusPath: slack.focusPath)
        #expect(try context.renderedText() == "Alex Lee [Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
        #expect(context.blocks.last?.frame == slack.focused.frame)
    }

    /// Outside web content a control's title may be an icon's label, so controls stay skipped.
    @Test func walkSkipsControlsOutsideWebContent() throws {
        let native = slackWindow(webArea: "AXGroup")
        let context = walk(native.window, focused: native.focused, focusPath: native.focusPath)
        #expect(try context.renderedText() == "[Today at 9:20 AM]\nThe draft is ready for review\n» ‸")
    }

    /// A heading, link, row or field in a point-thin box shows nothing, like text; the one shown
    /// piece beside them proves the walk reached them.
    @Test func walkLeavesOutEveryKindOfHiddenBlock() throws {
        let thin = CGRect(x: 10, y: 50, width: 300, height: 1)
        let area = FakeElement("AXWebArea", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [
            FakeElement("AXHeading", [kAXTitleAttribute: "Hidden heading"], frame: thin),
            FakeElement("AXLink", [kAXDescriptionAttribute: "Hidden link"], frame: thin),
            FakeElement("AXRow", [kAXDescriptionAttribute: "Hidden row"], frame: thin),
            FakeElement("AXTextField", [kAXValueAttribute: "Hidden field"], frame: thin),
            FakeElement("AXStaticText", [kAXValueAttribute: "Shown"], frame: CGRect(x: 10, y: 100, width: 60, height: 20)),
        ])
        let context = walk(FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [area]))
        #expect(try context.renderedText() == "Shown")
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
                                         excluding: ScreenExclusions(), started: Date(), into: &context))
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
        let text = "Visible. password: " + String(repeating: "x", count: 600000)
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
        func read(_ element: FakeElement, inside role: String) -> String {
            try! walk(FakeElement("AXWindow", children: [FakeElement(role, children: [element])])).renderedText()
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
    @Test func rowTextReadsATitledControlOnceAndOnlyShownFields() throws {
        let shown = CGRect(x: 20, y: 40, width: 100, height: 20)
        func read(_ row: FakeElement) -> String {
            try! walk(FakeElement("AXWindow", children: [FakeElement("AXWebArea", children: [row])])).renderedText()
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
    @Test func rowTextReadsWebControlsAndLeavesHiddenTextOut() throws {
        func read(inside role: String) -> String {
            let row = FakeElement("AXRow", frame: CGRect(x: 0, y: 100, width: 400, height: 30), children: [
                FakeElement("AXButton", [kAXTitleAttribute: "Sam Lee"], frame: CGRect(x: 0, y: 100, width: 80, height: 30)),
                FakeElement("AXStaticText", [kAXValueAttribute: "hidden"], frame: CGRect(x: 90, y: 100, width: 1, height: 1)),
                FakeElement("AXButton", [kAXDescriptionAttribute: "More actions"], frame: CGRect(x: 300, y: 100, width: 30, height: 30)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Draft"], frame: CGRect(x: 100, y: 100, width: 60, height: 30)),
            ])
            let area = FakeElement(role, frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [row])
            return try! walk(FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 800, height: 600), children: [area])).renderedText()
        }
        #expect(read(inside: "AXWebArea") == "| Sam Lee | Draft")
        #expect(read(inside: "AXGroup") == "| Draft")
    }

    /// A row's text view is part of its text: a native chat app's message is a text area in its
    /// table row, beside the time and the sender's name. One with nothing shown is left out.
    @Test func rowTextReadsATextArea() throws {
        let shown = CGRect(x: 20, y: 40, width: 300, height: 32)
        let row = FakeElement("AXRow", frame: CGRect(x: 0, y: 30, width: 400, height: 60), children: [
            FakeElement("AXCell", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "10:15"], frame: CGRect(x: 340, y: 40, width: 30, height: 16)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Alex Lee"], frame: CGRect(x: 20, y: 30, width: 100, height: 18)),
                FakeElement("AXImage", frame: shown),
                FakeElement("AXTextArea", [kAXValueAttribute: "Lunch tomorrow at noon?"], frame: shown),
                FakeElement("AXTextArea", [kAXValueAttribute: "Hidden draft"], frame: CGRect(x: 20, y: 40, width: 300, height: 1)),
            ]),
        ])
        let table = FakeElement("AXTable", frame: CGRect(x: 0, y: 0, width: 400, height: 600), children: [row])
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 400, height: 600), children: [table])
        #expect(try walk(window).renderedText() == "| 10:15 | Alex Lee | Lunch tomorrow at noon?")
    }

    /// A row's text is one block, cut at the block's size however long a text view in it is: what
    /// follows the cut is left out.
    @Test func rowTextIsCutAtTheBlockSize() throws {
        let cap = 20_000 // Common semantic contract, also exercised by the cross-platform corpus.
        let long = String(repeating: "word ", count: cap)
        let row = FakeElement("AXRow", frame: CGRect(x: 0, y: 30, width: 400, height: 60), children: [
            FakeElement("AXCell", children: [
                FakeElement("AXStaticText", [kAXValueAttribute: "10:15"], frame: CGRect(x: 340, y: 40, width: 30, height: 16)),
                FakeElement("AXTextArea", [kAXValueAttribute: long], frame: CGRect(x: 20, y: 40, width: 300, height: 32)),
                FakeElement("AXStaticText", [kAXValueAttribute: "Read"], frame: CGRect(x: 340, y: 60, width: 30, height: 16)),
            ]),
        ])
        let window = FakeElement("AXWindow", frame: CGRect(x: 0, y: 0, width: 400, height: 600), children: [row])
        let rendered = try walk(window).renderedText()
        #expect(rendered == "| " + String(("10:15 | " + long).prefix(cap)))
        #expect(rendered.count == cap + 2)
    }

    @Test func descendantRowsKeepCanonicalDuplicatesAndGraphemeBudgets() throws {
        func row(_ pieces: [String]) throws -> String {
            let children = pieces.map { FakeElement("AXStaticText", [kAXValueAttribute: $0]) }
            return try walk(FakeElement("AXWindow", children: [FakeElement("AXRow", children: children)])).renderedText()
        }
        #expect(try row([" é ", "e\u{301}", "\u{a0}next\u{a0}"]) == "| é | next")
        let family = "👨‍👩‍👧‍👦"
        #expect(try row([String(repeating: family, count: 1_001)]) == "| " + String(repeating: family, count: 1_001))
        #expect(try row([String(repeating: "e\u{301}", count: 20_001)]) == "| " + String(repeating: "e\u{301}", count: 20_000))
        #expect(throws: Redactor.Failure.self) { try row([String(repeating: family, count: 10_486)]) }
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
        let full = FakeElement("AXStaticText", [kAXValueAttribute: String(repeating: "x", count: 20_000)])
        #expect(try walk(FakeElement("AXWindow", children: [FakeElement("AXRow", children: [full, late])])).renderedText() == "| " + String(repeating: "x", count: 20_000))
        #expect(late.textReads == 0)
    }

    @Test func sharedScreenBudgetStopsBeforeAnotherNativeValueAndPreservesCaret() throws {
        let large = FakeElement("AXStaticText", [kAXValueAttribute: String(repeating: "x", count: 300_000)])
        let late = FakeElement("AXStaticText", [kAXValueAttribute: "must not be read"])
        let window = FakeElement("AXWindow", children: [large, late])
        var context = ScreenContext(appName: "Synthetic")
        context.textBeforeCaret = "left"; context.selectedText = "chosen"; context.textAfterCaret = "right"
        #expect(ScreenContextReader.walk(window, in: FakeScreenTree(), frame: nil, focused: nil, focusPath: [], excluding: ScreenExclusions(), started: Date(), into: &context))
        #expect(context.textBudgetFull && late.textReads == 0)
        let shown = try context.redacted
        #expect(shown.selectedText == "chosen")
        #expect(shown.blocks.reduce(0) { $0 + $1.text.utf8.count } <= 262_144 - "left‸chosen‸right".utf8.count)
    }

    @Test func summaryCarriesSizesNotText() throws {
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
    @Test func aScreenReadLogsEveryField() throws {
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

        let text = try context.logDescription

        #expect(text.hasPrefix("app Example (com.example.app), window title Inbox, host mail.example.com, terminal program vim, focused AXTextArea, stopped: time budget\n"))
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
        #expect(json["summary"]?.string == context.summary)
        #expect(try json["logDescription"]?.string == context.logDescription)
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
    func string(_ element: FakeElement, _ name: String) -> String? {
        if name == kAXValueAttribute || name == kAXTitleAttribute || name == kAXDescriptionAttribute { element.textReads += 1 }
        return name == kAXRoleAttribute ? element.role : element.attributes[name]
    }
    /// "hostUnknown" stands for an app that failed to give the page's address.
    func page(of webArea: FakeElement) -> PageHost {
        webArea.attributes["hostUnknown"] != nil ? .unknown : webArea.attributes["host"].map(PageHost.host) ?? .noHost
    }
    func fieldSource(of element: FakeElement, windowFrame: CGRect?) -> [String]? {
        element.textReads += 1
        return element.attributes[kAXValueAttribute].map { [element.attributes["fieldBefore"] ?? "", $0, element.attributes["fieldAfter"] ?? ""] }
    }
    func caretWindow(of element: FakeElement) -> SharedContext.CaretWindow? {
        guard let before = element.attributes["caretBefore"], let selected = element.attributes["caretSelected"],
              let after = element.attributes["caretAfter"] else { return nil }
        return SharedContext.CaretWindow(parts: [before, selected, after], selectionUnavailable: element.attributes["selectionUnavailable"] != nil)
    }
    func isSame(_ first: FakeElement, _ second: FakeElement) -> Bool { first === second }
    /// "editable" stands for an element whose text the app lets be changed.
    func isEditable(_ element: FakeElement) -> Bool { element.attributes["editable"] != nil }
}

// Verify separators through the real renderer without retaining native geometry policy.
private extension ScreenContext {
    static func separator(between first: Block, and second: Block) -> String {
        let a = try! SharedContext.process(blocks: [first]).rendered
        let b = try! SharedContext.process(blocks: [second]).rendered
        let both = try! SharedContext.process(blocks: [first, second]).rendered
        return String(both.dropFirst(a.count).dropLast(b.count))
    }
}
