# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Real helper IPC against synthetic Shell/IBus peers on a private bus."""
import json
import os
import select
import subprocess
import sys
import tempfile
import time
import gi

from gi.repository import Gio, GLib

os.environ['IBUS_ADDRESS'] = os.environ['DBUS_SESSION_BUS_ADDRESS']
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
# The portal's name is held too, unanswered, so configuring F8 starts no real portal on this bus.
for name in ['org.gnome.Shell', 'org.freedesktop.IBus', 'org.freedesktop.portal.Desktop']:
    reply = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', (name, 0)),
        None, Gio.DBusCallFlags.NONE, 1000, None)
    assert reply.unpack()[0] == 1

path = '/ai/tabmail/Voice/Caret'
interface = 'ai.tabmail.Voice.Caret'
info = Gio.DBusNodeInfo.new_for_xml('''<node><interface name="ai.tabmail.Voice.Caret">
<method name="Version"><arg type="u" direction="out"/></method>
<method name="Read"><arg type="s" direction="out"/></method>
<method name="SetRecording"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<method name="SetHotkey"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<signal name="Action"><arg type="s"/></signal></interface></node>''')
state = {'version': 2, 'rect': {'x': 120, 'y': 140, 'width': 1, 'height': 20},
         'recording': False, 'owner': None, 'language': 'ko', 'language_calls': 0, 'hotkey': []}


def shell_call(_bus, sender, _path, _interface, method, args, invocation):
    if method == 'Version':
        invocation.return_value(GLib.Variant('(u)', (state['version'],)))
    elif method == 'Read':
        invocation.return_value(GLib.Variant('(s)', (json.dumps(state['rect']),)))
    elif method == 'SetHotkey':
        state['hotkey'].append(args.unpack()[0])
        invocation.return_value(GLib.Variant('(b)', (True,)))
    else:
        assert method == 'SetRecording'
        state['recording'] = args.unpack()[0]
        state['owner'] = sender
        invocation.return_value(GLib.Variant('(b)', (True,)))


bus.register_object(path, info.interfaces[0], shell_call, None, None)
properties = Gio.DBusNodeInfo.new_for_xml('''<node><interface name="org.freedesktop.DBus.Properties">
<method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
</interface></node>''')


def engine_call(_bus, _sender, _path, _interface, _method, args, invocation):
    assert args.unpack() == ('org.freedesktop.IBus', 'GlobalEngine')
    state['language_calls'] += 1
    # IBus serializes EngineDesc as this public tuple, then wraps it in two
    # variants for Properties.Get. Construct wire data directly: the GI
    # serialize_object binding mismanages floating GVariant ownership.
    serialized = GLib.Variant('(sa{sv}ssssssssussssssss)', (
        'IBusEngineDesc', {}, 'synthetic', 'Synthetic', 'Synthetic',
        state['language'], 'MIT', 'Synthetic', '', 'us', 0,
        '', '', '', '', '', '', '', ''))
    payload = GLib.Variant('v', serialized)
    response = GLib.Variant('(v)', (payload,))
    invocation.return_value(response)


bus.register_object('/org/freedesktop/IBus', properties.interfaces[0], engine_call, None, None)
context = GLib.MainContext.default()


class Helper:
    def __init__(self, executable):
        self.log = tempfile.TemporaryFile()
        self.child = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log)
        os.set_blocking(self.child.stdout.fileno(), False)
        self.buffer = b''
        self.messages = []
        self.id = 0

    def pump(self):
        while context.iteration(False):
            pass
        if select.select([self.child.stdout], [], [], 0.001)[0]:
            self.buffer += os.read(self.child.stdout.fileno(), 65536)
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                self.messages.append(json.loads(line))

    def until(self, condition, timeout=2):
        end = time.monotonic() + timeout
        while not condition():
            assert time.monotonic() < end, (self.messages, state)
            self.pump()

    def request(self, method, params=None):
        self.id += 1
        self.child.stdin.write((json.dumps({'id': self.id, 'method': method, 'params': params or {}}) + '\n').encode())
        self.child.stdin.flush()
        self.until(lambda: any(m.get('id') == self.id for m in self.messages))
        return next(m for m in self.messages if m.get('id') == self.id)

    def quiet(self):
        end = time.monotonic() + 0.1
        while time.monotonic() < end:
            self.pump()

    def close(self):
        self.child.stdin.close()
        self.until(lambda: self.child.poll() is not None)
        assert self.child.returncode == 0
        self.log.close()


hotkey = Helper(sys.argv[1])
system = Helper(sys.argv[2])
try:
    hotkey.quiet()  # let the async session connection resolve
    assert hotkey.request('gnomeIntegration')['result'] is True
    assert hotkey.request('caretAnchor')['result'] == state['rect']
    # An extension loaded before an upgrade keeps running until the next login: not ready.
    for version in (1, 99):
        state['version'] = version
        assert hotkey.request('gnomeIntegration')['result'] is False
    state['rect'] = {'x': 1, 'y': 1, 'width': -1, 'height': 20}
    assert hotkey.request('caretAnchor')['result'] is None
    assert 'error' in hotkey.request('setRecording', {'active': 'yes'})
    assert not state['recording']
    assert hotkey.request('setRecording', {'active': True})['result'] == {}
    hotkey.until(lambda: state['recording'])

    def action(value):
        bus.emit_signal(state['owner'], path, interface, 'Action', GLib.Variant('(s)', (value,)))
        bus.flush_sync(None)
        hotkey.quiet()

    action('toggleMode')
    assert [m['action'] for m in hotkey.messages if 'action' in m] == ['toggleMode']
    assert hotkey.request('dictationEnded')['result'] == {}
    hotkey.until(lambda: not state['recording'])
    action('toggleMode')
    assert [m['action'] for m in hotkey.messages if 'action' in m] == ['toggleMode']
    hotkey.request('setRecording', {'active': True})
    hotkey.until(lambda: state['recording'])
    action('cancel')
    hotkey.until(lambda: not state['recording'])
    assert [m['action'] for m in hotkey.messages if 'action' in m] == ['toggleMode', 'cancel']
    action('cancel')
    assert [m['action'] for m in hotkey.messages if 'action' in m] == ['toggleMode', 'cancel']

    # Right Alt is held by the Shell, not the portal, and asked for again there; F8 lets it go.
    timing = {'tapMaxDuration': 0.3, 'doubleTapWindow': 0.4}
    assert hotkey.request('configure', {'hotkey': 'rightAlt', **timing})['result'] == {'installed': True}
    assert state['hotkey'] == [True]
    assert hotkey.request('requestHotkey')['result'] == {'installed': True}
    assert state['hotkey'] == [True, True]
    hotkey.request('configure', {'hotkey': 'F8', **timing})
    hotkey.until(lambda: state['hotkey'] == [True, True, False])

    system.quiet()
    assert system.request('keyboardLanguage')['result'] == {'code': 'ko'}
    assert state['language_calls'] > 0
    state['language'] = 'en'
    assert system.request('keyboardLanguage')['result'] == {'code': 'en'}
    state['language'] = ''
    assert system.request('keyboardLanguage')['result'] is None
    hotkey.close()
    system.close()
finally:
    for helper in [hotkey, system]:
        if helper.child.poll() is None:
            helper.child.kill()
            helper.child.wait()
print('Actual helper IPC, GNOME negotiation/actions/cleanup and live IBus language passed')
