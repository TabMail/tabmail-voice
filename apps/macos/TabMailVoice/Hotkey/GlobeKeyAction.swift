// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// The Globe (fn) key's own action, Keyboard settings' "Press 🌐 key to". macOS runs it ahead of
/// every event tap, so a press of fn as the hotkey also switched the input source. While fn is the
/// hotkey the app sets it to Do Nothing, and puts the user's choice back when fn stops being the
/// hotkey or the app quits (ADR-DESK-022).
@MainActor
final class GlobeKeyAction {
    /// The system's setting, through HIToolbox's private `TISGetFnUsageType`/`TISUpdateFnUsageType`,
    /// what System Settings itself calls: writing `AppleFnUsageType` directly takes effect only at
    /// the next login.
    @MainActor
    struct System {
        var read: () -> Int32
        var update: (Int32) -> Void

        /// Nil when this macOS no longer has the calls.
        static let live: System? = {
            typealias Read = @convention(c) () -> Int32
            typealias Update = @convention(c) (Int32) -> Void
            guard let carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", RTLD_LAZY),
                  let read = dlsym(carbon, "TISGetFnUsageType"),
                  let update = dlsym(carbon, "TISUpdateFnUsageType") else { return nil }
            return System(read: unsafeBitCast(read, to: Read.self), update: unsafeBitCast(update, to: Update.self))
        }()
    }

    /// `AppleFnUsageType`'s Do Nothing.
    nonisolated static let doNothing: Int32 = 0
    /// The user's choice while the app holds the key at Do Nothing. Kept in the app's defaults so a
    /// run that crashed is put right at the next launch.
    nonisolated static let savedChoiceKey = "globeKeyActionBeforeFnHotkey"

    private let system: System?
    private let defaults: UserDefaults

    init(system: System? = .live, defaults: UserDefaults = .standard) {
        self.system = system
        self.defaults = defaults
    }

    /// At launch and whenever the hotkey changes.
    func hotkeyIs(_ hotkey: DictationHotkey) {
        if hotkey == .function { takeOver() } else { restore() }
    }

    /// Puts the user's choice back, unless they picked another action since. At quit, too.
    func restore() {
        guard let saved = defaults.object(forKey: Self.savedChoiceKey) as? Int else { return }
        defaults.removeObject(forKey: Self.savedChoiceKey)
        guard let system, system.read() == Self.doNothing else {
            Log.debug("GlobeKeyAction: the Globe action was changed meanwhile; leaving it")
            return
        }
        system.update(Int32(saved))
        Log.debug("GlobeKeyAction: Globe action restored to \(saved)")
    }

    private func takeOver() {
        guard let system else {
            Log.error("GlobeKeyAction: TISUpdateFnUsageType unavailable; the Globe action stays on")
            return
        }
        // Already Do Nothing: the user's own choice, or ours with their choice saved.
        let current = system.read()
        guard current != Self.doNothing else { return }
        // Saved first, so a crash after the change still knows the way back.
        defaults.set(Int(current), forKey: Self.savedChoiceKey)
        system.update(Self.doNothing)
        Log.debug("GlobeKeyAction: Globe action \(current) set to Do Nothing while fn is the hotkey")
    }
}
