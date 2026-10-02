// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport
import VoiceMicrophoneKit

// Nothing here needs the main run loop: requests run on the channel's queue and the microphone on
// its own. The process ends itself when the input changes (`MicrophoneService`).
let channel = HelperChannel()
let service = MicrophoneService.register(on: channel)
channel.start()
withExtendedLifetime(service) { dispatchMain() }
