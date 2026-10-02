# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
import json
import subprocess
import sys
result = subprocess.run([sys.argv[1]], capture_output=True, text=True, timeout=5)
assert result.returncode == 0, result.stderr
assert [json.loads(line)['action'] for line in result.stdout.splitlines()] == [
    'start', 'toggleMode', 'cancel', 'start', 'finish', 'start',
    'start', 'finish', 'startHandsFree', 'listenHandsFree', 'cancel', 'toggleMode', 'cancel'
], result.stdout
print('GNOME recording ownership, ordered actions, idle rejection and teardown passed')
