// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import VoiceHelperSupport

/// `voice-screen-reader`'s one request, over `HelperChannel`: the screen read, in a program of its
/// own, so a read stuck in an app's Accessibility replies holds up nothing else and the app can end
/// it (`ScreenReader` in the app). `voice-macos` doesn't serve it.
///
/// - `readScreen {excludedAppIDs, excludedHosts}` → the screen context of the app in front
///   (`ScreenContext.json`); null without one; `{hidden: true}` when it is an app, or shows a
///   website, the user excludes from screen reading (`ScreenExclusions`), or a page whose address is
///   unknown, which is not read: nothing of it is sent, only that it is hidden. Secret-looking text is
///   taken out of it before it is sent (`Redactor`), and `selectionRedacted` says whether any was in
///   the selection.
public enum ScreenReaderService {
    @MainActor
    public static func register(on channel: HelperChannel) {
        register(on: channel, screen: .accessibility)
    }

    /// `screen` reads through Accessibility, or is a test's stand-in.
    @MainActor
    static func register(on channel: HelperChannel, screen: ScreenAccess) {
        channel.on("readScreen") { params in
            let exclusions = try ScreenExclusions(params: params, method: "readScreen")
            guard let (pid, name, bundleID) = await MainActor.run(body: screen.frontmost) else { return .null }
            if exclusions.excludesApp(bundleID) {
                HelperLog.debug("ScreenContext: the app in front is excluded from screen reading; not read")
                return hiddenScreen
            }
            // Blocking Accessibility calls: off the main thread, which answers the requests.
            return await Task.detached { () -> JSON in
                guard let context = screen.read(pid, name, bundleID, exclusions) else { return hiddenScreen }
                // The reader refuses an excluded website itself; a context on one never leaves the helper.
                if exclusions.excludesHost(context.host) {
                    HelperLog.debug("ScreenContext: the page read is on a website excluded from screen reading; dropped")
                    return hiddenScreen
                }
                return context.json
            }.value
        }
    }
}

/// `readScreen`'s answer for a screen that is not read for the user's privacy (an excluded app, a
/// page of an excluded website or of an unknown address): that it is hidden, and nothing of it, so
/// the app can tell the agent the screen was kept from it rather than empty.
private let hiddenScreen: JSON = ["hidden": .bool(true)]
