// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Observation

/// Reads the screen context of the frontmost app when a dictation starts, in the background while
/// the user speaks; the dictation's cleanup uses it if it is done in time. Debug builds keep the
/// latest capture in memory for the debug window. Logs sizes and timings; the text goes to the
/// debug log file only (ADR-DESK-015).
@MainActor
@Observable
final class ScreenContextProbe {
    /// The app whose screen is read.
    struct Target: Sendable {
        let pid: pid_t
        let name: String
        let bundleID: String?
    }

    #if DEBUG
    private(set) var lastContext: ScreenContext?
    @ObservationIgnored private var generation = 0
    #endif
    @ObservationIgnored private let isEnabled: @MainActor () -> Bool
    @ObservationIgnored private let isTrusted: () -> Bool
    @ObservationIgnored private let frontmostApp: () -> Target?
    @ObservationIgnored private let read: @Sendable (Target) async -> ScreenContext

    /// `isEnabled` is the user's screen-reading setting, asked at every capture.
    init(
        isEnabled: @escaping @MainActor () -> Bool,
        isTrusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        frontmostApp: @escaping () -> Target? = {
            NSWorkspace.shared.frontmostApplication.map {
                Target(pid: $0.processIdentifier, name: $0.localizedName ?? "", bundleID: $0.bundleIdentifier)
            }
        },
        read: @escaping @Sendable (Target) async -> ScreenContext = { target in
            await Task.detached {
                ScreenContextReader.read(pid: target.pid, appName: target.name, bundleID: target.bundleID)
            }.value
        }
    ) {
        self.isEnabled = isEnabled
        self.isTrusted = isTrusted
        self.frontmostApp = frontmostApp
        self.read = read
    }

    /// Nil with screen reading switched off, without the Accessibility grant, or without a
    /// frontmost app. The task yields the screen of the app that was frontmost when this was
    /// called, even if a newer capture has started since.
    func capture() -> Task<ScreenContext, Never>? {
        guard isEnabled(), isTrusted(), let target = frontmostApp() else { return nil }
        let read = read
        #if DEBUG
        generation += 1
        let current = generation
        #endif
        return Task {
            let context = await read(target)
            Log.debug("ScreenContext: \(context.summary)")
            Log.content("ScreenContext", context.logDescription)
            #if DEBUG
            if generation == current { lastContext = context }
            #endif
            return context
        }
    }
}
