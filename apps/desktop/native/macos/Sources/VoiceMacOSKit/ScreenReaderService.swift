// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import ApplicationServices
import CVoiceCore
import Foundation
import VoiceHelperSupport

/// `voice-screen-reader`'s requests, over `HelperChannel`: the screen read, in a program of its
/// own, so a read stuck in an app's Accessibility replies holds up nothing else and the app can end
/// it (`ScreenReader` in the app). `voice-macos` doesn't serve it.
///
/// - `readScreen {excludedAppIDs, excludedHosts}` → the screen context of the app in front
///   (`ScreenContext.json`, built by the shared core); null without one; `{hidden: true}` when it is
///   an app, or shows a website, the user excludes from screen reading (`ScreenExclusions`), or a page
///   whose address is unknown, which is not read: nothing of it is sent, only that it is hidden.
///   Secret-looking text is taken out of it before it is sent, and `selectionRedacted` says whether
///   any was in the selection. `read` (optional) numbers the read, so the app can stop it.
///   `wholeWindow` (optional, false): everything the window holds, on screen or not, rather than only
///   what it shows (the agent's `screen_read`, and dictation's terms when there is room).
///   `sameWindowAs` (optional, with `wholeWindow` only): the read numbered so whose window this read
///   must be: it is read only when that was the last read and its window is still the one in front,
///   and the answer is null otherwise, so a window that came to the front since is never read in
///   its place.
/// - `readScreenStop {read}` → null: the app stopped waiting for read `read`. That read, and any
///   numbered before it, ends at its next element and answers with what it has read so far, laid
///   out and redacted as a whole read is (ADR-DESK-053). Reads numbered after it are not affected,
///   so a stop that arrives late never cuts short the next read.
public enum ScreenReaderService {
    @MainActor
    public static func register(on channel: HelperChannel) {
        register(on: channel, screen: .accessibility, targets: TargetWindows())
    }

    /// `screen` reads through Accessibility, or is a test's stand-in.
    @MainActor
    static func register(on channel: HelperChannel, screen: ScreenAccess, targets: TargetWindows? = nil) {
        let stops = ScreenReadStops()
        let windows = ScreenReadWindows()
        channel.on("captureTarget") { _ in
            await MainActor.run { targets?.capture() ?? .null }
        }
        channel.on("cancelPaste") { params in
            guard let target = params["target"], let targets else { throw HelperError("target window unavailable") }
            try targets.cancel(target)
            return [:]
        }
        channel.on("pasteTarget") { params in
            guard let target = params["target"], let transaction = params["transaction"]?.integer,
                  let deadline = params["deadline"]?.number, deadline.isFinite else { throw HelperError("invalid target paste") }
            _ = try SharedRequest.call(["pasteTarget": ["target": target, "transaction": .number(Double(transaction)), "deadline": .number(deadline), "now": .number(floor(Date().timeIntervalSince1970 * 1000))]])
            guard let targets else { throw HelperError("target window unavailable") }
            try await targets.paste(target, transaction: transaction, deadline: deadline)
            return [:]
        }
        channel.on("readScreenStop") { params in
            guard let read = try readNumber(params, "readScreenStop") else { throw HelperError("readScreenStop needs read") }
            stops.ask(read)
            return .null
        }
        channel.on("readScreen") { params in
            let exclusions = try ScreenExclusions(params: params, method: "readScreen")
            let request = try screenRead(params)
            let bound: TargetWindows.Target?
            if let identity = request.target {
                bound = try await MainActor.run { try targets?.resolve(identity) }
                guard bound != nil else { return .null }
            } else { bound = nil }
            let app: (pid_t, String, String?)?
            if let bound { app = (bound.pid, bound.name, bound.bundleID) }
            else { app = await MainActor.run(body: screen.frontmost) }
            guard let (pid, name, bundleID) = app else { return .null }
            // Another app in front than the read it is bound to: nothing of it is looked at.
            guard windows.follows(request, pid: pid) else {
                HelperLog.debug("ScreenContext: another app is in front than the read this one follows; not read")
                return .null
            }
            if exclusions.excludesApp(bundleID) {
                HelperLog.debug("ScreenContext: the app in front is excluded from screen reading; not read")
                return hiddenScreen
            }
            // Blocking Accessibility calls: off the main thread, which answers the requests.
            return await Task.detached { () -> JSON in
                let window = bound?.window ?? screen.window(pid)
                guard windows.admits(request, pid: pid, window: window) else {
                    HelperLog.debug("ScreenContext: another window is in front than the read this one follows; not read")
                    return .null
                }
                guard let context = screen.read(pid, name, bundleID, window, exclusions, request.wholeWindow, { stops.asked(request.read) }) else { return hiddenScreen }
                // The reader refuses an excluded website itself; the shared core checks the page read
                // once more, so a context on one never leaves the helper.
                let reply = context.json(exclusions)
                if reply == hiddenScreen {
                    HelperLog.debug("ScreenContext: the page read is on a website excluded from screen reading, or the shared core refused it; dropped")
                }
                return reply
            }.value
        }
    }

    /// The request's `read`, as the shared core accepts it (`voice_core_request_json`, its cases in
    /// `shared/context/request-cases.json`): a whole number from 1, or nil for a read with no number.
    private static func readNumber(_ params: JSON, _ method: String) throws -> Int? {
        try coreRequest(params, method, fields: ["read"])["read"]?.integer
    }

    /// A `readScreen` request's `read` (as `readNumber`), `wholeWindow` (false when absent) and
    /// `sameWindowAs`, as the shared core accepts them.
    private static func screenRead(_ params: JSON) throws -> ScreenRead {
        let reply = try coreRequest(params, "readScreen", fields: ["read", "wholeWindow", "sameWindowAs", "target"])
        guard case .bool(let wholeWindow) = reply["wholeWindow"] else { throw HelperError("readScreen: the shared core gave no wholeWindow") }
        return ScreenRead(read: reply["read"]?.integer, wholeWindow: wholeWindow, sameWindowAs: reply["sameWindowAs"]?.integer, target: reply["target"])
    }

    private static func coreRequest(_ params: JSON, _ method: String, fields names: [String]) throws -> JSON {
        var fields: [String: JSON] = [:]
        for name in names { if let value = params[name] { fields[name] = value } }
        let refused = HelperError("\(method) needs read as a whole number from 1, wholeWindow, if any, true or false, and sameWindowAs, if any, a read number with wholeWindow")
        guard let input = try? JSONEncoder().encode(JSON.object([method: .object(fields)])),
              let output = try? Redactor.request(input, operation: .request),
              let reply = try? JSONDecoder().decode(JSON.self, from: output) else { throw refused }
        return reply
    }
}

/// A `readScreen` request as the shared core accepted it.
struct ScreenRead: Sendable {
    var read: Int?
    var wholeWindow: Bool
    /// The read whose window this one must be, if any.
    var sameWindowAs: Int?
    var target: JSON? = nil
}

/// The window the last numbered read read (its app's process and the app's focused window then),
/// so a read bound to it (`sameWindowAs`) reads that window or nothing. Asked on the channel's tasks
/// and the reads' own, so behind a lock.
final class ScreenReadWindows: @unchecked Sendable {
    private struct Last { var read: Int; var pid: pid_t; var window: AXUIElement? }
    private let lock = NSLock()
    private var last: Last?

    /// Whether `request` may go on in the app `pid`, before its window is looked up: unbound, or
    /// bound to the last read, of this app.
    func follows(_ request: ScreenRead, pid: pid_t) -> Bool {
        guard let bound = request.sameWindowAs else { return true }
        return lock.withLock { last.map { $0.read == bound && $0.pid == pid } ?? false }
    }

    /// Whether `request` may go on with `window`, the app's focused window now: unbound, or bound to
    /// the last read, whose window this still is. A read that goes on with a number becomes the
    /// last read.
    func admits(_ request: ScreenRead, pid: pid_t, window: AXUIElement?) -> Bool {
        lock.withLock {
            if let bound = request.sameWindowAs {
                guard let previous = last, previous.read == bound, previous.pid == pid, Self.same(previous.window, window) else { return false }
            }
            if let read = request.read { last = Last(read: read, pid: pid, window: window) }
            return true
        }
    }

    private static func same(_ first: AXUIElement?, _ second: AXUIElement?) -> Bool {
        switch (first, second) {
        case (nil, nil): return true
        case let (first?, second?): return CFEqual(first, second)
        default: return false
        }
    }
}

/// The reads the app has asked to stop, as the shared core decides (`voice_core_screen_read_stop`,
/// `voice_core_screen_read_asked`). Asked on the channel's tasks, checked by the walk on its own
/// thread: the core's state is atomic, so both may run at once, and it lives at one address for the
/// service's life.
final class ScreenReadStops: @unchecked Sendable {
    private let state = UnsafeMutablePointer<VoiceScreenReadStops>.allocate(capacity: 1)

    init() { state.initialize(to: VoiceScreenReadStops()) }
    deinit { state.deallocate() }

    func ask(_ read: Int) {
        voice_core_screen_read_stop(state, Int64(read))
    }

    /// Whether read `read` is asked to stop; one with no number never is.
    func asked(_ read: Int?) -> Bool {
        voice_core_screen_read_asked(state, Int64(read ?? 0)) != 0
    }
}

/// `readScreen`'s answer for a screen that is not read for the user's privacy (an excluded app, a
/// page of an excluded website or of an unknown address): that it is hidden, and nothing of it, so
/// the app can tell the agent the screen was kept from it rather than empty.
private let hiddenScreen: JSON = ["hidden": .bool(true)]
