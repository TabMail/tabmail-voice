// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Testing
@testable import VoiceMacOSKit

struct GlobeKeyTests {
    /// The calls exist on this macOS. Only read: the real setting is never changed by a test.
    @Test func theSystemCallsExist() throws {
        let globe = try #require(GlobeKey.live)
        #expect((0...3).contains(globe.read()))
    }
}
