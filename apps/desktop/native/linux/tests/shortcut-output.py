# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
import json
import subprocess
import sys

result = subprocess.run([sys.argv[1]], capture_output=True, text=True, timeout=10)
assert result.returncode == 0, result.stderr
messages = [json.loads(line) for line in result.stdout.splitlines()]
actions = [message["action"] for message in messages if message.get("event") == "action"]
assert actions == ["start", "finish", "start", "cancel", "startAgent", "finish", "start", "finish", "startHandsFree", "listenHandsFree", "toggleMode", "cancel", "closeChat", "start", "cancel"], actions
# Disabled for Right Alt: the dictation is cancelled, then the app hears once that the keys are gone.
assert messages[-2:] == [{"event": "action", "action": "cancel"}, {"event": "hotkeyInstallationChanged", "installed": False}], messages[-2:]
print("Ordered shortcut actions and active-recording revocation cancellation passed")
