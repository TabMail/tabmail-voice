# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Isolate activated services as well as D-Bus names from the real desktop."""
import os
import subprocess
import sys
import tempfile

# Set this before dbus-run-session starts: its activation environment, not just
# the fixture's environment, determines where AT-SPI creates its bus socket.
with tempfile.TemporaryDirectory(prefix='voice-test-runtime-') as runtime:
    env = dict(os.environ, XDG_RUNTIME_DIR=runtime, GIO_USE_VFS='local')
    env.pop('AT_SPI_BUS_ADDRESS', None)
    sys.exit(subprocess.call(sys.argv[1:], env=env))
