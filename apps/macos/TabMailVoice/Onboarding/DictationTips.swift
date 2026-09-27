// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// A tip the overlay shows under the listening pill, as TipKit tips behave: it shows until the user
/// has done what it teaches, or has seen it `maxDisplays` times, and then never again.
enum DictationTip: String, CaseIterable, Sendable {
    /// Space switches between dictation and agent mode: shown as a hold starts listening.
    case switchMode
    /// A double tap of the hotkey dictates without holding it: shown once a hold passes
    /// `DictationConfig.doubleTapTipHoldDuration`.
    case doubleTap

    var maxDisplays: Int {
        switch self {
        case .switchMode: DictationConfig.switchModeTipMaxDisplays
        case .doubleTap: DictationConfig.doubleTapTipMaxDisplays
        }
    }

    var displayDuration: Duration {
        switch self {
        case .switchMode: DictationConfig.switchModeTipDisplayDuration
        case .doubleTap: DictationConfig.doubleTapTipDisplayDuration
        }
    }
}

/// Which tips have been shown how often, and which the user has learned, kept in UserDefaults.
@MainActor
final class TipBook {
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// Whether `tip` may still show.
    func isEligible(_ tip: DictationTip) -> Bool {
        !defaults.bool(forKey: Self.learnedKey(tip)) && defaults.integer(forKey: Self.displaysKey(tip)) < tip.maxDisplays
    }

    func recordDisplay(_ tip: DictationTip) {
        defaults.set(defaults.integer(forKey: Self.displaysKey(tip)) + 1, forKey: Self.displaysKey(tip))
    }

    /// The user did what `tip` teaches: it never shows again.
    func markLearned(_ tip: DictationTip) {
        defaults.set(true, forKey: Self.learnedKey(tip))
    }

    private static func displaysKey(_ tip: DictationTip) -> String { "tip.\(tip.rawValue).displays" }
    private static func learnedKey(_ tip: DictationTip) -> String { "tip.\(tip.rawValue).learned" }
}
