// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A window for `appkit-field.mjs`: a one-line field in focus over a long text view out of focus,
// its start in view and its tail scrolled out of it. AppKit's text view gives its whole text to
// Accessibility (Chromium caps a field's at 10,000 characters, below the length where the two
// scopes differ). Prints "ready" once in front; ends when its stdin closes.
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 80, y: 200, width: 600, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Synthetic AppKit field"
let content = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 300))
let focus = NSTextField(string: "Synthetic focus")
focus.frame = NSRect(x: 20, y: 260, width: 560, height: 24)
let scroll = NSTextView.scrollableTextView()
scroll.frame = NSRect(x: 20, y: 20, width: 560, height: 220)
let text = scroll.documentView as! NSTextView
text.string = "Synthetic visible start\n" + String(repeating: "Synthetic filler words\n", count: 13000) + "Synthetic hidden tail"
text.scroll(.zero)
content.addSubview(focus)
content.addSubview(scroll)
window.contentView = content
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(focus)
// Taken to the front as Electron's `app.focus({steal: true})` does: started from a shell, a
// cooperative `activate()` leaves it behind the terminal.
protocol Stealing { func steal() }
extension NSApplication: Stealing {
    @available(macOS, deprecated: 14.0)
    func steal() { activate(ignoringOtherApps: true) }
}
(app as Stealing).steal()
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() ? "ready" : "not in front")
    fflush(stdout)
}
FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { exit(0) }
}
app.run()
