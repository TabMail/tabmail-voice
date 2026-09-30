// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import VoiceHelperSupport
import VoiceHotkeyKit

// The event tap's source is added to the main run loop, which this process does nothing but run.
let channel = HelperChannel()
let monitor = MainActor.assumeIsolated { HotkeyService.register(on: channel) }
channel.start()
withExtendedLifetime(monitor) { CFRunLoopRun() }
