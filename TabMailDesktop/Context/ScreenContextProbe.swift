// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Observation

/// Phase 2 prototype: reads the screen context of the frontmost app when a dictation starts, in
/// the background while the user speaks. Keeps only the latest capture, in memory; logs sizes
/// and timings, never the text.
@MainActor
@Observable
final class ScreenContextProbe {
    private(set) var lastContext: ScreenContext?
    @ObservationIgnored private var generation = 0

    func capture() {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return }
        let pid = app.processIdentifier
        let name = app.localizedName ?? ""
        let bundleID = app.bundleIdentifier
        generation += 1
        let current = generation
        Task {
            let context = await Task.detached {
                ScreenContextReader.read(pid: pid, appName: name, bundleID: bundleID)
            }.value
            Log.debug("ScreenContext: \(context.summary)")
            guard generation == current else { return }
            lastContext = context
        }
    }
}
