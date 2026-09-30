// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import VoiceMacOSKit

/// Only engines that build their accessibility tree on request are asked; every other app is
/// left alone.
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
}
