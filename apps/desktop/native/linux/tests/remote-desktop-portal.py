# This Source Code Form is subject to the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""A synthetic RemoteDesktop + Clipboard portal on the private session bus. It grants every session,
takes every offered selection, and reports what reaches it on stdout: `ready`, `publish` for each
SetSelection and `key <keysym> <state>` for each key event. Ends when stdin closes."""
import sys
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

DESKTOP = '/org/freedesktop/portal/desktop'
SESSION = DESKTOP + '/session/synthetic'
XML = '''<node>
  <interface name="org.freedesktop.host.portal.Registry"><method name="Register"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method></interface>
  <interface name="org.freedesktop.portal.RemoteDesktop">
    <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    <method name="SelectDevices"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    <method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    <method name="NotifyKeyboardKeysym"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
  </interface>
  <interface name="org.freedesktop.portal.Clipboard">
    <method name="RequestClipboard"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/></method>
    <method name="SetSelection"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/></method>
  </interface>
  <interface name="org.freedesktop.portal.Session"><method name="Close"/></interface>
</node>'''


def report(line):
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(connection, sender, path, interface, method, args, invocation):
    args = args.unpack()
    if method in ('CreateSession', 'SelectDevices', 'Start'):
        options = args[-1]
        request = f"{DESKTOP}/request/{sender[1:].replace('.', '_')}/{options['handle_token']}"
        results = {}
        if method == 'CreateSession':
            results['session_handle'] = GLib.Variant('s', SESSION)
        if method == 'Start':
            results['devices'] = GLib.Variant('u', 1)
            results['clipboard_enabled'] = GLib.Variant('b', True)
        invocation.return_value(GLib.Variant('(o)', (request,)))
        connection.emit_signal(sender, request, 'org.freedesktop.portal.Request', 'Response',
                               GLib.Variant('(ua{sv})', (0, results)))
    elif method == 'SetSelection':
        report('publish')
        invocation.return_value(None)
        connection.emit_signal(None, DESKTOP, 'org.freedesktop.portal.Clipboard', 'SelectionOwnerChanged',
                               GLib.Variant('(oa{sv})', (SESSION, {
                                   'mime_types': GLib.Variant('as', ['text/plain;charset=utf-8']),
                                   'session_is_owner': GLib.Variant('b', True)})))
    elif method == 'NotifyKeyboardKeysym':
        report(f'key {args[2]} {args[3]}')
        invocation.return_value(None)
    else:
        invocation.return_value(None)


for interface in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
    bus.register_object(SESSION if interface.name == 'org.freedesktop.portal.Session' else DESKTOP, interface, call)
reply = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
                      GLib.Variant('(su)', ('org.freedesktop.portal.Desktop', 4)), GLib.VariantType('(u)'),
                      Gio.DBusCallFlags.NONE, 1000, None)
assert reply.unpack()[0] == 1, 'the synthetic portal owns its name'
loop = GLib.MainLoop()
GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP,
                  lambda channel, condition: loop.quit() if not sys.stdin.readline() else True)
report('ready')
loop.run()
