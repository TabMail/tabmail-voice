// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport
import VoiceMacOSKit

// voice-field-reader: the focused field's read for correction learning, and nothing else
// (`FieldReaderService`). The main run loop answers which app is in front; the Accessibility read
// runs off it.
MainActor.assumeIsolated {
    let channel = HelperChannel()
    FieldReaderService.register(on: channel)
    channel.start()
    CFRunLoopRun()
}
