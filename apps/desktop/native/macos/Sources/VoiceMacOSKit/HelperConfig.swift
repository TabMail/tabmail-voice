// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import CoreGraphics
import Foundation

/// Every tunable number `voice-macos` uses on its own. The rest are the app's
/// (`src/core/config.ts`), sent with the requests that need them.
enum HelperConfig {
    // MARK: Insertion

    /// Pause between posting a keystroke's key-down and key-up events.
    static let pasteKeystrokeGap: Duration = .milliseconds(10)

    // MARK: Screen context

    /// Accessibility messaging timeout for the target app's own element while reading the screen
    /// context (seconds). macOS applies it to that element only; the elements reached from it
    /// (focused field, window, children) wait up to the system-wide timeout.
    static let contextLookupTimeout: Float = 0.25
    /// The walk of the focused window stops after this many elements…
    static var contextNodeBudget: Int { SharedWalk.limits.nodeBudget }
    /// …or after this long (seconds). It runs in the background while the user speaks. Both are
    /// the shared core's (ADR-DESK-054).
    static var contextTimeBudget: Double { Double(SharedWalk.limits.timeBudgetMilliseconds) / 1000 }
    /// Most parents followed from the focused element up to its window (deep web pages ≈ 40).
    static var contextMaxFocusDepth: Int { SharedWalk.limits.focusDepth }
    /// Each AX role as one of the shared core's roles, which decide how the walk reads it
    /// (ADR-DESK-054): controls and toolbars are interface chrome in native apps, which title their
    /// icon buttons, and content in web pages (a chat message's author is a button, a chat's
    /// header with the conversation's name a toolbar); menus, images and scroll bars are chrome
    /// everywhere. A role not listed is a container, walked into.
    static let contextRoles: [String: String] = [
        "AXWebArea": "page", "AXStaticText": "text", "AXHeading": "heading", "AXLink": "link", "AXRow": "row",
        "AXTextField": "field", "AXTextArea": "field",
        "AXButton": "control", "AXMenuButton": "control", "AXPopUpButton": "control", "AXCheckBox": "control",
        "AXRadioButton": "control", "AXToolbar": "toolbar",
        "AXMenuBar": "chrome", "AXMenu": "chrome", "AXMenuItem": "chrome", "AXImage": "chrome", "AXScrollBar": "chrome",
        "AXSlider": "chrome", "AXIncrementor": "chrome",
    ]
    /// Roles the caret is in when focused: the text around it is read, and the walk never goes
    /// into them. Any other focused element is read like the rest of the window.
    static let contextFieldRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]
    /// Elements at most this thin (points) show nothing: web apps keep screen-reader-only text,
    /// list items scrolled out of view and hover-only actions in 1-point boxes.
    static let contextHiddenMaxThickness: CGFloat = 1
    /// Terminal apps use native visible-range and caret acquisition.
    static let terminalBundleIDs: Set<String> = [
        "com.googlecode.iterm2", "com.apple.Terminal", "com.mitchellh.ghostty", "com.github.wez.wezterm",
        "net.kovidgoyal.kitty", "org.alacritty",
    ]


    // MARK: Caret

    /// A "caret" rect wider than this is a line or text box; the caret is its leading edge.
    static let caretMaxWidth: CGFloat = 4
    /// Without a caret, the focused element's frame anchors the overlay if it's at most this tall
    /// (a text field); taller elements (a whole editor or web view) fall back to the mouse pointer.
    static let focusedElementMaxAnchorHeight: CGFloat = 120
    /// Per-call cap on Accessibility calls into the frontmost app when locating the caret (seconds).
    static let caretLookupTimeout: Float = 0.1
    /// Cap on asking an app to build its accessibility tree (seconds). Off the main thread, and Gecko
    /// may be slow to answer while it starts its accessibility service.
    static let accessibilityActivationTimeout: Float = 1
    /// An app that doesn't answer in time is asked again after this long, up to
    /// `accessibilityActivationAttempts` requests in all, while it stays in front.
    static let accessibilityActivationRetryDelay: Duration = .seconds(1)
    static let accessibilityActivationAttempts = 5

    // MARK: Focused field

    /// Per-call cap on Accessibility calls reading the focused field after a paste (seconds).
    static let focusedFieldTimeout: Float = 0.25
    /// Longest the window is looked through for a page of an excluded website before the focused
    /// field is read (seconds): the field is read every half second while corrections are watched.
    static let focusedFieldPageScanBudget: Double = 0.2

    // MARK: Email apps

    /// Asked for the app that opens it, to find the user's default email app.
    static let mailtoURL = URL(string: "mailto:")!
    /// Largest app icon drawn for the app (pixels square); it asks for one bubble's worth.
    static let appIconMaxPixels: Double = 1_024
    /// Accessibility calls into Thunderbird give up after this long (seconds).
    static let thunderbirdAccessibilityTimeout: Float = 0.5

    // MARK: Files

    /// The most items Spotlight gathers for one file search before the newest are kept: a bound on a
    /// search as broad as one letter.
    static let filesSearchScanLimit = 500
}
