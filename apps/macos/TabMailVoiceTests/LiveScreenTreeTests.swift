// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import Testing
@testable import TabMailVoice

/// The walk on a real window through Accessibility (`LiveScreenTree`), the test host's own: the
/// frames it reads reach the layout. Needs the Accessibility permission for the test runner (a
/// terminal that has it passes it on); without it the test fails rather than passing unread.
@MainActor
struct LiveScreenTreeTests {
    @Test func liveFramesLayTheWindowOutInLines() async throws {
        let title = "Live screen tree test"
        let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 500, height: 200), styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.title = title
        // Closing must not free the window: Swift still owns it (a window made in code is freed on
        // close by default, and the second release crashed the test host).
        window.isReleasedWhenClosed = false
        // AppKit's y grows up: two labels side by side, one below them.
        for (text, frame) in [("Left", NSRect(x: 20, y: 100, width: 80, height: 20)),
                              ("Right", NSRect(x: 120, y: 100, width: 80, height: 20)),
                              ("Below", NSRect(x: 20, y: 60, width: 80, height: 20))] {
            let label = NSTextField(labelWithString: text)
            label.frame = frame
            window.contentView?.addSubview(label)
        }
        window.orderFront(nil)
        defer { window.close() }

        try #require(AXIsProcessTrusted(), "the test runner needs the Accessibility permission")
        let pid = getpid()
        // The walk blocks; the app answers Accessibility on the main thread, so read off it.
        let context = await Task.detached { () -> ScreenContext? in
            let windows = CaretLocator.attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement] ?? []
            guard let axWindow = windows.first(where: { CaretLocator.attribute($0, kAXTitleAttribute) as? String == title }) else { return nil }
            var context = ScreenContext(appName: "Test")
            ScreenContextReader.walk(axWindow, in: LiveScreenTree(), frame: CaretLocator.frame(of: axWindow), focused: nil,
                                     focusPath: [], started: Date(), into: &context)
            return context
        }.value
        let read = try #require(context)
        #expect(read.renderedText().hasPrefix("Left Right\nBelow"))
        #expect(read.blocks.prefix(3).allSatisfy { $0.frame.map { !$0.isEmpty } ?? false })
    }
}
