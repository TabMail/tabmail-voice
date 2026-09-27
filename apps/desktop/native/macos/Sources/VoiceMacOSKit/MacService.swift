// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import VoiceHelperSupport

/// `voice-macos`'s requests, over `HelperChannel`. Rects are in screen points with the origin at the
/// primary screen's top-left and y down: Accessibility's coordinates and Electron's alike.
///
/// - `frontmostApp` → `{pid, name, bundleIdentifier, path}` or null.
/// - `readScreen` → the screen context of the app in front (`ScreenContext.json`), or null without one.
/// - `caretAnchor {pid}` → the caret's (or the focused field's) rect, or null.
/// - `insert {text, restoreDelay}` → `{}`: pastes `text` into the focused field, then restores the
///   clipboard after `restoreDelay` seconds.
/// - `keyboardLanguage` → `{code}`: the active keyboard input source's language, or null.
/// - `globeRead` → `{value}` (null when this macOS lacks the calls); `globeUpdate {value}` → `{}`.
/// - `startActivator` → `{}`: asks Gecko and Electron apps to build their accessibility tree as they
///   come to the front. Again after the Accessibility grant.
/// - `emailApps {bundleIdentifiers}` → `{systemDefault, installed}`.
/// - `appPath {bundleIdentifier}` → `{path}`; `isRunning`, `hasWindow`, `isFrontmost` → `{value}`;
///   `launch {path}`, `activate {bundleIdentifier}` → `{}`; `focusedElement {bundleIdentifier}` →
///   `{role, windowTitle}` or null; `openTabMailChat`, `pressReturn` → `{}`.
public enum MacService {
    @MainActor
    public static func register(on channel: HelperChannel) -> AnyObject {
        let activator = AccessibilityActivator()

        channel.on("frontmostApp") { _ in await MainActor.run { Apps.frontmost() } }
        channel.on("readScreen") { _ in
            let target: (pid_t, String, String?)? = await MainActor.run {
                NSWorkspace.shared.frontmostApplication.map { ($0.processIdentifier, $0.localizedName ?? "", $0.bundleIdentifier) }
            }
            guard let (pid, name, bundleID) = target else { return .null }
            // Blocking Accessibility calls: off the main thread, where the activator's notifications run.
            return await Task.detached { ScreenContextReader.read(pid: pid, appName: name, bundleID: bundleID).json }.value
        }
        channel.on("caretAnchor") { params in
            guard let pid = params["pid"]?.number else { throw HelperError("caretAnchor needs pid") }
            return await Task.detached { () -> JSON in
                guard let cocoa = CaretLocator.anchorRect(inApp: pid_t(pid)),
                      let primaryHeight = NSScreen.screens.first?.frame.height else { return .null }
                // The flip is its own inverse: back to Accessibility's top-left coordinates.
                return .rect(CaretLocator.cocoaRect(fromAccessibility: cocoa, primaryScreenHeight: primaryHeight))
            }.value
        }
        channel.on("insert") { params in
            guard let text = params["text"]?.string, let delay = params["restoreDelay"]?.number else {
                throw HelperError("insert needs text and restoreDelay")
            }
            await TextInserter(restoreDelay: .milliseconds(Int(delay * 1000))).insert(text)
            return [:]
        }
        channel.on("keyboardLanguage") { _ in
            await MainActor.run { ["code": KeyboardLanguage.current().map(JSON.string) ?? .null] }
        }
        channel.on("globeRead") { _ in
            ["value": GlobeKey.live.map { .number(Double($0.read())) } ?? .null]
        }
        channel.on("globeUpdate") { params in
            guard let value = params["value"]?.number else { throw HelperError("globeUpdate needs value") }
            guard let globe = GlobeKey.live else { throw HelperError("TISUpdateFnUsageType unavailable") }
            globe.update(Int32(value))
            return [:]
        }
        channel.on("startActivator") { _ in
            await MainActor.run { activator.start() }
            return [:]
        }
        channel.on("emailApps") { params in
            let ids = params["bundleIdentifiers"]?.array?.compactMap(\.string) ?? []
            return await MainActor.run {
                [
                    "systemDefault": Apps.systemEmailApp()?.json ?? .null,
                    "installed": .array(Apps.installed(ids).map(\.json)),
                ]
            }
        }
        channel.on("appPath") { params in
            let id = try bundleIdentifier(params)
            return await MainActor.run { ["path": NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { .string($0.path) } ?? .null] }
        }
        channel.on("isRunning") { params in ["value": .bool(Apps.running(try bundleIdentifier(params)) != nil)] }
        channel.on("launch") { params in
            guard let path = params["path"]?.string else { throw HelperError("launch needs path") }
            try await Apps.launch(path)
            return [:]
        }
        channel.on("hasWindow") { params in ["value": .bool(await Apps.hasWindow(try bundleIdentifier(params)))] }
        channel.on("activate") { params in
            await Apps.activate(try bundleIdentifier(params))
            return [:]
        }
        channel.on("isFrontmost") { params in
            let id = try bundleIdentifier(params)
            return await MainActor.run { ["value": .bool(Apps.isFrontmost(id))] }
        }
        channel.on("focusedElement") { params in await Apps.focusedElement(try bundleIdentifier(params)) }
        channel.on("openTabMailChat") { _ in
            await Apps.postOpenChat()
            return [:]
        }
        channel.on("pressReturn") { _ in
            await Apps.postReturn()
            return [:]
        }
        return activator
    }

    private static func bundleIdentifier(_ params: JSON) throws -> String {
        guard let id = params["bundleIdentifier"]?.string else { throw HelperError("bundleIdentifier missing") }
        return id
    }
}

extension ScreenContext {
    /// What the app receives: the fields, and the text already rendered for the prompts and the logs.
    var json: JSON {
        func optional(_ value: String?) -> JSON { value.map(JSON.string) ?? .null }
        return [
            "appName": .string(appName),
            "bundleID": optional(bundleID),
            "windowTitle": optional(windowTitle),
            "host": optional(host),
            "terminalProgram": optional(terminalProgram),
            "focusedRole": optional(focusedRole),
            "textBeforeCaret": .string(textBeforeCaret),
            "selectedText": .string(selectedText),
            "textAfterCaret": .string(textAfterCaret),
            "renderedText": .string(renderedText()),
            "summary": .string(summary),
            "logDescription": .string(logDescription),
        ]
    }
}
