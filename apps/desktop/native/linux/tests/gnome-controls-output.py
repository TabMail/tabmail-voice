# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
import json
import subprocess
import sys
result = subprocess.run([sys.argv[1]], capture_output=True, text=True, timeout=5)
assert result.returncode == 0, result.stderr
lines = [json.loads(line) for line in result.stdout.splitlines()]
assert [line['action'] for line in lines if line['event'] == 'action'] == [
    'start', 'toggleMode', 'cancel', 'start', 'finish', 'start',
    'start', 'finish', 'startHandsFree', 'listenHandsFree', 'cancel', 'toggleMode', 'cancel',
    'startAgent', 'toggleMode', 'cancel', 'startAgentHandsFree', 'toggleMode', 'cancel',
    'closeChat',
    'start', 'finish', 'startAgent', 'finish'
], result.stdout
# Right Alt held by the Shell, given back as AltGr, held again once the Shell is ready, let go,
# then held again.
assert [line['installed'] for line in lines if line['event'] == 'hotkeyInstallationChanged'] == [True, False, True, False, True], result.stdout
# Only while Right Alt is wanted does its refusal reach the app.
assert len([line for line in lines if line['event'] == 'hotkeyUnavailable']) == 1, result.stdout
print('GNOME recording ownership, ordered actions, chat Escape, Right Alt, idle rejection and teardown passed')
