// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport
import VoiceMacOSKit

// The main run loop delivers workspace notifications (the accessibility activator) and runs the
// requests that must be on the main thread (Text Input Sources).
MainActor.assumeIsolated {
    let channel = HelperChannel()
    let service = MacService.register(on: channel)
    channel.start()
    withExtendedLifetime(service) { CFRunLoopRun() }
}
