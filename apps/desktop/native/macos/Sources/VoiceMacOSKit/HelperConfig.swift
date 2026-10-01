// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import CoreGraphics
import Foundation

/// Every tunable number `voice-macos` uses on its own. The rest are the app's
/// (`src/core/config.ts`), sent with the requests that need them.
enum HelperConfig {
    // MARK: Microphone

    /// Frames per captured buffer, at the device's rate (≈ 85 ms at 48 kHz): the Swift app's
    /// `audioTapBufferSize`.
    static let microphoneTapBufferSize: AVAudioFrameCount = 4096

    // MARK: Insertion

    /// Pause between posting a keystroke's key-down and key-up events.
    static let pasteKeystrokeGap: Duration = .milliseconds(10)

    // MARK: Screen context

    /// Accessibility messaging timeout for the target app's own element while reading the screen
    /// context (seconds). macOS applies it to that element only; the elements reached from it
    /// (focused field, window, children) wait up to the system-wide timeout.
    static let contextLookupTimeout: Float = 0.25
    /// The walk of the focused window stops after this many elements…
    static let contextNodeBudget = 5_000
    /// …or after this long (seconds). It runs in the background while the user speaks.
    static let contextTimeBudget: Double = 1.5
    /// Longest a helper command (tmux, ps) may run while reading the context (seconds); they
    /// normally answer in milliseconds.
    static let contextCommandTimeout: Double = 0.5
    /// Most parents followed from the focused element up to its window (deep web pages ≈ 40).
    static let contextMaxFocusDepth = 200
    /// Characters kept on each side of the caret.
    static let contextCaretWindowChars = 2_000
    /// Longest visible text kept from one text field or terminal.
    static let contextMaxFieldChars = 20_000
    /// Longest text gathered for one heading, link or table row.
    static let contextMaxBlockChars = 1_000
    /// Roles whose text is interface chrome, not content: skipped with their subtree.
    static let contextSkippedRoles: Set<String> = [
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXMenuBar",
        "AXMenu", "AXMenuItem", "AXToolbar", "AXImage", "AXScrollBar", "AXSlider", "AXIncrementor",
    ]
    /// Controls read in web content, where the text drawn in them is content (a chat message's
    /// author is a button); native apps title their icon buttons, so there they stay skipped.
    static let contextWebControlRoles: Set<String> = [
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton",
    ]
    /// Skipped roles read after all in web content: its controls, and toolbars, which there hold
    /// content (a chat's header with the conversation's name).
    static let contextWebReadRoles: Set<String> = contextWebControlRoles.union(["AXToolbar"])
    /// Elements at most this thin (points) show nothing: web apps keep screen-reader-only text,
    /// list items scrolled out of view and hover-only actions in 1-point boxes.
    static let contextHiddenMaxThickness: CGFloat = 1
    /// Two pieces of text are on one line when they overlap by this share of the shorter's height.
    static let contextSameLineOverlap: CGFloat = 0.5
    /// Terminal apps: their foreground program is looked up through tmux.
    static let terminalBundleIDs: Set<String> = [
        "com.googlecode.iterm2", "com.apple.Terminal", "com.mitchellh.ghostty", "com.github.wez.wezterm",
        "net.kovidgoyal.kitty", "org.alacritty",
    ]
    /// A tmux pane counts as the terminal in front when this share of its last non-blank lines
    /// (up to `tmuxPaneSampleLines`) appears in the front terminal's text.
    static let tmuxPaneSampleLines = 12
    static let tmuxPaneRequiredShare = 0.75
    /// How much of the front terminal's text (from the end) the pane lines are looked for in.
    static let tmuxScreenTailChars = 60_000
    /// Where tmux is installed (Homebrew on Apple silicon, Homebrew on Intel, system).
    static let tmuxPaths = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]

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
