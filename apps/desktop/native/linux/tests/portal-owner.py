# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Real helper lifecycle on a private bus; never touches the desktop portal."""
import json
import selectors
import subprocess
import sys
import time

from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
service = 'org.freedesktop.portal.Desktop'


def name(method):
    args = GLib.Variant('(su)', (service, 0)) if method == 'RequestName' else GLib.Variant('(s)', (service,))
    return bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                         'org.freedesktop.DBus', method, args, None,
                         Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]


def alive(child, method):
    child.stdin.write(json.dumps({'id': 1, 'method': method, 'params': {}}) + '\n')
    child.stdin.flush()
    with selectors.DefaultSelector() as ready:
        ready.register(child.stdout, selectors.EVENT_READ)
        assert ready.select(3), 'helper must answer while portal is absent'
        reply = json.loads(child.stdout.readline())
        assert reply['id'] == 1 and 'result' in reply, reply
    assert child.poll() is None


for executable, method in [(sys.argv[1], 'dictationEnded'), (sys.argv[2], 'insertionPermission')]:
    # Twice proves that a restarted helper survives the outage, then watches the
    # replacement owner too. A missing watcher leaves the process alive on loss.
    for visit in range(2):
        with subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True) as child:
            try:
                time.sleep(0.2)
                alive(child, method)
                assert name('RequestName') == 1
                time.sleep(0.2)  # allow the main-context name notification to run
                alive(child, method)
                assert name('ReleaseName') == 1  # no Session::Closed is sent
                assert child.wait(timeout=3) == 1, 'owner loss must discard helper state'
            finally:
                if child.poll() is None:
                    child.kill()
                name('ReleaseName')
print('Both helpers survive initial absence and exit on each observed portal owner loss')
