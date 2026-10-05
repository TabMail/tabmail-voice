// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport
import VoiceMacOSKit

// voice-screen-reader: the screen read, and nothing else (`ScreenReaderService`). The main run loop
// answers which app is in front; the Accessibility walk runs off it.
MainActor.assumeIsolated {
    let channel = HelperChannel()
    ScreenReaderService.register(on: channel)
    channel.start()
    CFRunLoopRun()
}
