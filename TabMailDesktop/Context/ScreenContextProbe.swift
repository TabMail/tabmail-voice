// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Observation

/// Reads the screen context of the frontmost app when a dictation starts, in the background while
/// the user speaks; the dictation's cleanup waits for it. Keeps the latest capture in memory for
/// the debug window; logs sizes and timings, never the text.
@MainActor
@Observable
final class ScreenContextProbe {
    private(set) var lastContext: ScreenContext?
    @ObservationIgnored private var generation = 0

    /// Nil without the Accessibility grant or a frontmost app.
    func capture() -> Task<ScreenContext, Never>? {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = app.processIdentifier
        let name = app.localizedName ?? ""
        let bundleID = app.bundleIdentifier
        generation += 1
        let current = generation
        return Task {
            let context = await Task.detached {
                ScreenContextReader.read(pid: pid, appName: name, bundleID: bundleID)
            }.value
            Log.debug("ScreenContext: \(context.summary)")
            if generation == current { lastContext = context }
            return context
        }
    }
}
