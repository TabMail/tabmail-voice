// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import Foundation
import Testing
@testable import VoiceMacOSKit

/// Only engines that build their accessibility tree on request are asked; every other app is
/// left alone. An app is asked each time it comes to the front, and again, a bounded number of
/// times, while it doesn't answer in time.
@MainActor
struct AccessibilityActivatorTests {
    private let bundle = URL(fileURLWithPath: "/Applications/Example.app")

    private func engine(with files: Set<String>) -> AccessibilityActivator.Engine? {
        AccessibilityActivator.engine(of: bundle) { files.contains($0) }
    }

    @Test func geckoAppsAreRecognizedByTheirXULLibrary() {
        #expect(engine(with: ["/Applications/Example.app/Contents/MacOS/XUL"]) == .gecko)
    }

    @Test func electronAppsAreRecognizedByTheirFramework() {
        #expect(engine(with: ["/Applications/Example.app/Contents/Frameworks/Electron Framework.framework"]) == .electron)
    }

    @Test func otherAppsAreLeftAlone() {
        #expect(engine(with: []) == nil)
        #expect(AccessibilityActivator.engine(of: nil) { _ in true } == nil)
    }

    /// The requests an activator sent, answered in turn by `replies` (the last one repeated).
    private final class Requests: @unchecked Sendable {
        private let lock = NSLock()
        private var replies: [AXError]
        private var pids: [pid_t] = []
        private var times: [ContinuousClock.Instant] = []

        init(_ replies: [AXError]) { self.replies = replies }

        var sent: [pid_t] { lock.withLock { pids } }
        /// The time between each request and the next.
        var gaps: [Duration] { lock.withLock { zip(times.dropFirst(), times).map { $0 - $1 } } }

        func answer(_ engine: AccessibilityActivator.Engine, _ pid: pid_t) -> AXError {
            lock.withLock {
                pids.append(pid)
                times.append(ContinuousClock.now)
                return replies.count > 1 ? replies.removeFirst() : replies[0]
            }
        }
    }

    private func activator(_ requests: Requests, retryDelay: Duration = .zero) -> AccessibilityActivator {
        AccessibilityActivator(request: { requests.answer($0, $1) }, retryDelay: retryDelay)
    }

    @Test func anAppThatDoesNotAnswerInTimeIsAskedAgainUntilItAnswers() async {
        let requests = Requests([.cannotComplete, .cannotComplete, .success])
        await activator(requests).cameToFront((.electron, 42))?.value
        #expect(requests.sent == [42, 42, 42])
    }

    @Test func theRetriesAreSpacedByTheRetryDelay() async {
        let requests = Requests([.cannotComplete, .cannotComplete, .success])
        let delay = Duration.milliseconds(500)
        await activator(requests, retryDelay: delay).cameToFront((.electron, 42))?.value
        #expect(requests.sent == [42, 42, 42])
        #expect(requests.gaps.count == 2)
        #expect(requests.gaps.allSatisfy { $0 >= delay })
    }

    @Test func anAppThatNeverAnswersIsAskedABoundedNumberOfTimes() async {
        let requests = Requests([.cannotComplete])
        await activator(requests).cameToFront((.electron, 42))?.value
        #expect(requests.sent == Array(repeating: 42, count: HelperConfig.accessibilityActivationAttempts))
    }

    @Test func anAppThatAnswersIsAskedOnce() async {
        for reply in [AXError.success, .attributeUnsupported] {
            let requests = Requests([reply])
            await activator(requests).cameToFront((.gecko, 7))?.value
            #expect(requests.sent == [7])
        }
    }

    @Test func anAppIsAskedEveryTimeItComesToTheFront() async {
        let requests = Requests([.success])
        let activator = activator(requests)
        await activator.cameToFront((.electron, 42))?.value
        await activator.cameToFront((.electron, 42))?.value
        await activator.cameToFront((.electron, 42))?.value
        #expect(requests.sent == [42, 42, 42])
    }

    @Test func anotherAppComingToTheFrontStopsTheRetries() async {
        let requests = Requests([.cannotComplete])
        let activator = activator(requests, retryDelay: .seconds(60))
        let first = activator.cameToFront((.electron, 1))
        let second = activator.cameToFront((.electron, 2))
        await first?.value
        second?.cancel()
        await second?.value
        #expect(requests.sent.filter { $0 == 1 } == [1])
    }

    @Test func anAppThatNeedsNoAskingComingToTheFrontStopsTheRetries() async {
        let requests = Requests([.cannotComplete])
        let activator = activator(requests, retryDelay: .seconds(60))
        let first = activator.cameToFront((.electron, 1))
        #expect(activator.cameToFront(nil) == nil)
        await first?.value
        #expect(requests.sent == [1])
    }

    /// Through the workspace notification, as the system posts it: the test runner is neither a
    /// Gecko nor an Electron app, so coming to the front it is asked nothing and stops the retries.
    @Test func anActivationOfAnAppThatNeedsNoAskingStopsTheRetries() async {
        let requests = Requests([.cannotComplete])
        let activator = activator(requests, retryDelay: .seconds(60))
        activator.start()
        let first = activator.cameToFront((.electron, 1))
        NSWorkspace.shared.notificationCenter.post(
            name: NSWorkspace.didActivateApplicationNotification, object: NSWorkspace.shared,
            userInfo: [NSWorkspace.applicationUserInfoKey: NSRunningApplication.current]
        )
        await first?.value
        #expect(requests.sent.filter { $0 == 1 } == [1])
    }
}
