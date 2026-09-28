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
/// - `appIcon {path, pixels}` → `{png}`: the app's icon, `pixels` square, as base64 PNG; null when
///   it can't be drawn.
/// - `appPath {bundleIdentifier}` → `{path}`; `isRunning`, `hasWindow`, `isFrontmost` → `{value}`;
///   `launch {path}`, `activate {bundleIdentifier}` → `{}`; `focusedElement {bundleIdentifier}` →
///   `{role, windowTitle}` or null; `openTabMailChat`, `pressReturn` → `{}`.
/// - `microphonePrepare` → `{}`: the microphone-off setup, ahead of the first dictation.
/// - `microphoneStart {session, sampleRate}` → `{}` once the microphone runs; then events
///   `{"event": "microphoneChunk", session, samples}`, `samples` being base64 of little-endian
///   32-bit float mono samples at `sampleRate`, and `{"event": "microphoneLost", session}` should the
///   microphone stop by itself. `microphoneStop {session}` → `{}`: the microphone off.
public enum MacService {
    static let microphoneChunkEvent = "microphoneChunk"
    static let microphoneLostEvent = "microphoneLost"

    /// A chunk event's fields: its session, and its samples as base64 of little-endian 32-bit floats.
    static func microphoneChunk(session: Int, samples: [Float]) -> [String: JSON] {
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        return ["session": .number(Double(session)), "samples": .string(data.base64EncodedString())]
    }

    /// A lost event's fields: the session whose microphone stopped by itself.
    static func microphoneLost(session: Int) -> [String: JSON] {
        ["session": .number(Double(session))]
    }

    @MainActor
    public static func register(on channel: HelperChannel) -> AnyObject {
        let activator = AccessibilityActivator()
        // Off the render thread: encoding and writing a chunk must never hold up the audio.
        let chunkQueue = DispatchQueue(label: "ai.tabmail.voice.helper.microphoneChunks", qos: .userInitiated)
        let microphone = MicrophoneCapture(
            onSamples: { session, samples in
                chunkQueue.async {
                    channel.emit(microphoneChunkEvent, microphoneChunk(session: session, samples: samples))
                }
            },
            // After the chunks already queued, so the app has all that was heard.
            onLost: { session in
                chunkQueue.async {
                    channel.emit(microphoneLostEvent, microphoneLost(session: session))
                }
            }
        )

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
            guard let pid = params["pid"]?.integer.flatMap({ pid_t(exactly: $0) }) else { throw HelperError("caretAnchor needs pid") }
            return await Task.detached { () -> JSON in
                guard let cocoa = CaretLocator.anchorRect(inApp: pid),
                      let primaryHeight = NSScreen.screens.first?.frame.height else { return .null }
                // The flip is its own inverse: back to Accessibility's top-left coordinates.
                return .rect(CaretLocator.cocoaRect(fromAccessibility: cocoa, primaryScreenHeight: primaryHeight))
            }.value
        }
        channel.on("insert") { params in
            guard let text = params["text"]?.string, let delay = params["restoreDelay"]?.number,
                  let milliseconds = Int(exactly: (delay * 1000).rounded()), milliseconds >= 0 else {
                throw HelperError("insert needs text and restoreDelay")
            }
            await TextInserter(restoreDelay: .milliseconds(milliseconds)).insert(text)
            return [:]
        }
        channel.on("keyboardLanguage") { _ in
            await MainActor.run { ["code": KeyboardLanguage.current().map(JSON.string) ?? .null] }
        }
        channel.on("globeRead") { _ in
            ["value": GlobeKey.live.map { .number(Double($0.read())) } ?? .null]
        }
        channel.on("globeUpdate") { params in
            guard let value = params["value"]?.integer.flatMap({ Int32(exactly: $0) }) else { throw HelperError("globeUpdate needs value") }
            guard let globe = GlobeKey.live else { throw HelperError("TISUpdateFnUsageType unavailable") }
            globe.update(value)
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
        channel.on("appIcon") { params in
            guard let path = params["path"]?.string, let pixels = params["pixels"]?.number,
                  pixels == pixels.rounded(), (1...HelperConfig.appIconMaxPixels).contains(pixels) else {
                throw HelperError("appIcon needs path and a whole number of pixels")
            }
            return await MainActor.run { ["png": Apps.iconPNG(path, pixels: Int(pixels)).map { .string($0.base64EncodedString()) } ?? .null] }
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
        channel.on("microphonePrepare") { _ in
            await microphone.prepare()
            return [:]
        }
        channel.on("microphoneStart") { params in
            guard let session = params["session"]?.integer, let sampleRate = params["sampleRate"]?.number, sampleRate > 0 else {
                throw HelperError("microphoneStart needs session and sampleRate")
            }
            do {
                try await microphone.start(session: session, sampleRate: sampleRate)
            } catch {
                throw HelperError("microphone: \(type(of: error))")
            }
            return [:]
        }
        channel.on("microphoneStop") { params in
            guard let session = params["session"]?.integer else { throw HelperError("microphoneStop needs session") }
            await microphone.stop(session: session)
            return [:]
        }
        channel.on("pressReturn") { _ in
            await Apps.postReturn()
            return [:]
        }
        return [activator, microphone] as NSArray
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
