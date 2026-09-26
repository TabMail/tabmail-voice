// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Observation

/// First-run setup, laid out like the Thunderbird welcome wizard: steps grouped under categories
/// in a top rail, Back and Next below, Finish on the last step. Consent comes first and must be
/// given before any other step; permissions and features can be skipped and changed later.
@MainActor
@Observable
final class WelcomeWizard {
    enum Step: CaseIterable {
        case consent
        case microphone
        case accessibility
        case screenReading
    }

    struct Category {
        let label: String
        let steps: [Step]
    }

    static let categories = [
        Category(label: "Consent", steps: [.consent]),
        Category(label: "Permissions", steps: [.microphone, .accessibility]),
        Category(label: "Features", steps: [.screenReading]),
    ]
    static let steps = categories.flatMap(\.steps)

    private(set) var index = 0
    /// Called once Finish is pressed on the last step.
    @ObservationIgnored var onFinish: (() -> Void)?
    @ObservationIgnored private let settings: AppSettings

    init(settings: AppSettings) {
        self.settings = settings
    }

    var step: Step { Self.steps[index] }
    var categoryIndex: Int { Self.categories.firstIndex { $0.steps.contains(step) } ?? 0 }
    var isFirstStep: Bool { index == 0 }
    var isLastStep: Bool { index == Self.steps.count - 1 }
    /// Next (or Finish) is available once this step allows it: only consent has a requirement.
    var canAdvance: Bool { step != .consent || settings.hasConsented }

    func next() {
        guard canAdvance else { return }
        if isLastStep {
            settings.hasFinishedWelcome = true
            onFinish?()
        } else {
            index += 1
        }
    }

    func back() {
        guard !isFirstStep else { return }
        index -= 1
    }

    /// A rail bubble returns to a step already reached, never skips ahead (as in Thunderbird).
    func goTo(_ target: Int) {
        guard target >= 0, target <= index else { return }
        index = target
    }
}
