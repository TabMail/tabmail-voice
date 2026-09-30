// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// The Globe (fn) key's own action, Keyboard settings' "Press 🌐 key to", through HIToolbox's private
/// `TISGetFnUsageType`/`TISUpdateFnUsageType`, what System Settings itself calls: writing
/// `AppleFnUsageType` directly takes effect only at the next login. When to change it is the app's
/// (`GlobeKeyAction`, ADR-DESK-031); this only reads and writes it.
struct GlobeKey: Sendable {
    var read: @Sendable () -> Int32
    var update: @Sendable (Int32) -> Void

    /// Nil when this macOS no longer has the calls.
    static let live: GlobeKey? = {
        typealias Read = @convention(c) () -> Int32
        typealias Update = @convention(c) (Int32) -> Void
        guard let carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", RTLD_LAZY),
              let read = dlsym(carbon, "TISGetFnUsageType"),
              let update = dlsym(carbon, "TISUpdateFnUsageType") else { return nil }
        let readCall = unsafeBitCast(read, to: Read.self)
        let updateCall = unsafeBitCast(update, to: Update.self)
        return GlobeKey(read: { readCall() }, update: { updateCall($0) })
    }()
}
