// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import VoiceHelperSupport

/// Other apps, as the app asks about them: the one in front, the email apps, and the primitives the
/// Thunderbird connector (`ThunderbirdRelay` in the app) drives Thunderbird with.
enum Apps {
    struct App: Equatable, Sendable {
        let bundleIdentifier: String
        let name: String
        let path: String

        var json: JSON { ["bundleIdentifier": .string(bundleIdentifier), "name": .string(name), "path": .string(path)] }
    }

    /// The app in front: its process, name, bundle identifier and bundle path.
    @MainActor
    static func frontmost() -> JSON {
        guard let app = NSWorkspace.shared.frontmostApplication else { return .null }
        return [
            "pid": .number(Double(app.processIdentifier)),
            "name": .string(app.localizedName ?? ""),
            "bundleIdentifier": app.bundleIdentifier.map(JSON.string) ?? .null,
            "path": app.bundleURL.map { .string($0.path) } ?? .null,
        ]
    }

    /// The app the system opens `mailto:` links with.
    @MainActor
    static func systemEmailApp() -> App? {
        NSWorkspace.shared.urlForApplication(toOpen: HelperConfig.mailtoURL).flatMap(app(at:))
    }

    /// Those of `bundleIdentifiers` installed on this Mac, in that order.
    @MainActor
    static func installed(_ bundleIdentifiers: [String]) -> [App] {
        bundleIdentifiers.compactMap { id in NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).flatMap(app(at:)) }
    }

    /// The icon of the app at `path` as PNG, `pixels` square. Drawn here: an icon file lookup
    /// that rasterizes at once (Electron's `getFileIcon`) can catch the system's blank placeholder,
    /// shown while the real icon loads.
    @MainActor
    static func iconPNG(_ path: String, pixels: Int) -> Data? {
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSWorkspace.shared.icon(forFile: path).draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:])
    }

    static func app(at url: URL) -> App? {
        guard let id = Bundle(url: url)?.bundleIdentifier else { return nil }
        return App(bundleIdentifier: id, name: FileManager.default.displayName(atPath: url.path), path: url.path)
    }

    /// Whether the app is one the user excludes from screen reading. Bundle identifiers are compared
    /// without regard to case, as macOS does; an app without one can't be excluded.
    static func isExcluded(_ bundleIdentifier: String?, by excluded: [String]) -> Bool {
        guard let id = bundleIdentifier?.lowercased() else { return false }
        return excluded.contains { $0.lowercased() == id }
    }

    static func running(_ bundleIdentifier: String) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first { !$0.isTerminated }
    }

    @MainActor
    static func launch(_ path: String) async throws {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        _ = try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration)
    }

    /// Runs `probe` on the app's Accessibility element off the main thread. `absent` when it isn't
    /// running.
    static func accessibility<T: Sendable>(_ bundleIdentifier: String, absent: T, _ probe: @escaping @Sendable (AXUIElement) -> T) async -> T {
        guard let pid = running(bundleIdentifier)?.processIdentifier else { return absent }
        return await Task.detached { probe(timed(AXUIElementCreateApplication(pid))) }.value
    }

    static func hasWindow(_ bundleIdentifier: String) async -> Bool {
        await accessibility(bundleIdentifier, absent: false) { app in
            (CaretLocator.attribute(app, kAXWindowsAttribute) as? [AXUIElement]).map { !$0.isEmpty } ?? false
        }
    }

    /// This app is never active (menu bar, non-activating overlay), and macOS's cooperative
    /// activation ignores an activation request from an inactive app; Accessibility can still bring
    /// an app to the front.
    static func activate(_ bundleIdentifier: String) async {
        let result: Int32? = await accessibility(bundleIdentifier, absent: nil) { app in
            AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue).rawValue
        }
        guard let result else { return }
        HelperLog.debug("Apps: asked \(bundleIdentifier) to the front (\(result))")
    }

    @MainActor
    static func isFrontmost(_ bundleIdentifier: String) -> Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleIdentifier
    }

    /// The app's focused element's role and the title of the window it is in.
    static func focusedElement(_ bundleIdentifier: String) async -> JSON {
        await accessibility(bundleIdentifier, absent: .null) { app in
            guard let element = CaretLocator.attribute(app, kAXFocusedUIElementAttribute) else { return .null }
            let focused = timed(element as! AXUIElement)
            let window = CaretLocator.attribute(focused, kAXWindowAttribute).map { timed($0 as! AXUIElement) }
            return [
                "role": (CaretLocator.attribute(focused, kAXRoleAttribute) as? String).map(JSON.string) ?? .null,
                "windowTitle": window.flatMap { CaretLocator.attribute($0, kAXTitleAttribute) as? String }.map(JSON.string) ?? .null,
            ]
        }
    }

    /// TabMail's open-chat shortcut in Thunderbird, ⌥⌘L.
    static func postOpenChat() async {
        await TextInserter.postKeystroke(CGKeyCode(kVK_ANSI_L), flags: [.maskAlternate, .maskCommand])
    }

    static func postReturn() async {
        await TextInserter.postKeystroke(CGKeyCode(kVK_Return), flags: [])
    }
}

/// `element`, whose Accessibility calls into Thunderbird give up after
/// `thunderbirdAccessibilityTimeout`. Each element has its own timeout: set it on every element asked.
private func timed(_ element: AXUIElement) -> AXUIElement {
    AXUIElementSetMessagingTimeout(element, HelperConfig.thunderbirdAccessibilityTimeout)
    return element
}
