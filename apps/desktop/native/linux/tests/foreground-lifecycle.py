# This Source Code Form is subject to the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Drive the real native service through foreground callbacks and GLib timers.

Run once over the main helper, which serves the foreground, the caret and the paste; once (second
argument `reader`) over voice-screen-reader, the program that reads the screen; and once (`field`)
over voice-field-reader, the program that reads the focused field. The same fixture commands drive
all three."""
import json
import os
import select
import subprocess
import sys
import tempfile
import time

# A synthetic RemoteDesktop portal reports each selection the helper offers and each key it sends.
portal = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'remote-desktop-portal.py')],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)  # unbuffered: select() sees every line
assert portal.stdout.readline() == b'ready\n', 'the synthetic portal starts'
control_read, control_write = os.pipe()
ack_read, ack_write = os.pipe()
# Stand-in processes: a script, so the kernel names the process after it, that sleeps. A copy of
# /bin/sleep can't stand in: a multicall coreutils (Ubuntu's Rust one) picks its program by its own file
# name and exits at once under another, and an exited process keeps its name but not its environment.
def stand_in(path):
    with open(path, 'w') as script:
        script.write(f'#!{sys.executable} -I\nimport time\ntime.sleep(600)\n')
    os.chmod(path, 0o700)


# A process named as Flatpak's bus proxy, which accessibility names for a sandboxed app ('P').
proxy_dir = tempfile.TemporaryDirectory()
proxy_path = os.path.join(proxy_dir.name, 'xdg-dbus-proxy')
stand_in(proxy_path)
proxy = subprocess.Popen([proxy_path])
# A process its launcher names ('A'): started as a launcher starts an app, with GIO_LAUNCHED_DESKTOP_FILE
# naming a desktop file in a data directory the fixture looks in.
launched_id = 'ai.tabmail.SyntheticLaunched.desktop'
os.mkdir(os.path.join(proxy_dir.name, 'applications'))
launched_path = os.path.join(proxy_dir.name, 'synthetic-launched')
stand_in(launched_path)
desktop_file = os.path.join(proxy_dir.name, 'applications', launched_id)
with open(desktop_file, 'w') as entry:
    entry.write(f'[Desktop Entry]\nType=Application\nName=Launched synthetic app\nExec={launched_path}\n')
launched = subprocess.Popen([launched_path], env={**os.environ, 'GIO_LAUNCHED_DESKTOP_FILE': desktop_file})
time.sleep(0.2)
assert proxy.poll() is None and launched.poll() is None, 'the synthetic proxy and launched processes are running'
with tempfile.TemporaryFile(mode='w+t') as diagnostics:
    reader = sys.argv[2:] == ['reader']
    fields = sys.argv[2:] == ['field']
    assert sys.argv[2:] in ([], ['reader'], ['field'])
    child = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=diagnostics, text=True, pass_fds=(control_read, ack_write), env={**os.environ,
        'VOICE_FIXTURE_CONTROL': str(control_read), 'VOICE_FIXTURE_ACK': str(ack_write), 'VOICE_FIXTURE_PROXY': str(proxy.pid),
        'VOICE_FIXTURE_LAUNCHED': str(launched.pid), 'XDG_DATA_DIRS': proxy_dir.name + ':' + os.environ.get('XDG_DATA_DIRS', '/usr/local/share:/usr/share')})
    os.close(control_read)
    os.close(ack_write)
    acknowledgments = os.fdopen(ack_read)
    sequence = 0
    policy = {'excludedAppIDs': [], 'excludedHosts': []}
    # The stand-in's two apps, each a process of its own (foreground-provider.cpp).
    first, second = 4194305, 4194306

    def line(stream):
        assert select.select([stream], [], [], 3)[0], 'native fixture response timed out'
        value = stream.readline()
        assert value, 'native fixture exited unexpectedly'
        return value

    def request(method, params=None, refused=False):
        global sequence
        sequence += 1
        child.stdin.write(json.dumps({'id': sequence, 'method': method, 'params': params or policy}) + '\n')
        child.stdin.flush()
        reply = json.loads(line(child.stdout))
        # An event (insertionPermissionChanged) can precede the reply in the same read; the reply may
        # already be buffered, where select() would not see it, so read it directly (ctest bounds the wait).
        while 'event' in reply:
            reply = json.loads(child.stdout.readline())
        assert reply['id'] == sequence, reply
        if refused:
            assert 'error' in reply and 'result' not in reply, reply
            return None
        assert 'error' not in reply, reply
        return reply['result']

    def command(value):
        os.write(control_write, value.encode())
        return tuple(map(int, line(acknowledgments).split()))

    def wait_calls(expected):
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            counts = command('s')
            if counts == expected:
                return
            assert all(a <= b for a, b in zip(counts, expected)), 'activation exceeded retry limit'
            time.sleep(0.03)
        raise AssertionError('activation did not recover within retry budget')

    # Each check runs in the process that serves it: the screen in the reader, the field in the field
    # reader, the rest in the helper.
    def screen(params=None):
        return request('readScreen', params) if reader else True

    def portal_events(settle):
        events, deadline = [], time.monotonic() + settle
        while (wait := deadline - time.monotonic()) > 0 and select.select([portal.stdout], [], [], wait)[0]:
            events.append(portal.stdout.readline().decode().strip())
        return events

    def paste(window, refused):
        deadline = int(time.time() * 1000) + 2000
        request('insert', {'window': window, 'text': 'Synthetic held paste', 'deadline': deadline}, refused=refused)

    # The field reader is asked for the field of the app pasted into by its process, as voice-linux's
    # frontmostApp names it: it reads the window in front only while that window is the app's.
    def field(pid=first):
        if not fields:
            return None
        return request('focusedFieldValue', {**policy, 'pid': pid, 'maxLength': 20000})

    def target():
        return True if reader else field() if fields else request('frontmostApp')

    try:
        if reader:
            # Sent the moment the reader starts, as the app does after restarting it for a read that
            # supersedes another: the read waits for the reader to find what has focus.
            assert 'First synthetic app' in screen()['renderedText'], 'a read sent as the reader starts finds the app in front'
            # A reader that has read nothing numbered yet (a restarted one) reads no window bound to a read.
            assert request('readScreen', {**policy, 'read': 1, 'wholeWindow': True, 'sameWindowAs': 1}) is None, \
                'a read bound to one this reader never read is not read'
            for method in ('frontmostApp', 'focusedFieldValue', 'caretAnchor', 'insert', 'redactText', 'wordFrequencies'):
                request(method, refused=True)
        elif fields:
            # Asked the moment the field reader starts, as the app does after restarting it when a new
            # watch's read supersedes one still going: the answer waits for the reader to find what has focus.
            assert field() == {'value': 'Synthetic field content'}, 'a read sent as the field reader starts finds the app in front'
            for method in ('frontmostApp', 'readScreen', 'caretAnchor', 'insert', 'redactText', 'wordFrequencies', 'requestInsertion'):
                request(method, refused=True)
        else:
            assert request('redactText', {'text': 'token=syntheticPrivate123'}) == {'text': 'token=[redacted]'}
            assert request('redactText', {'text': ''}) == {'text': ''}
            for before, text, after, expected in [
                ('token=', 'syntheticPrivate123. Public.', '', '[redacted] Public.'),
                ('', 'Public. token=synthetic', 'Private123 later.', 'Public. token=[redacted]'),
                ('Earlier.', '会議は金曜日です。', '次のページ', '会議は金曜日です。'),
            ]:
                assert request('redactText', {'before': before, 'text': text, 'after': after}) == {'text': expected}
            request('redactText', {'text': 'Public.', 'before': None}, refused=True)
            request('redactText', {'text': None}, refused=True)
            request('redactText', {'text': '😀' * 32769}, refused=True)
            # The screen terms' test (ADR-DESK-038, amended 2026-11-05): the shared core's answer from the
            # app's word list; the rule's own cases run in the core.
            lists = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../shared/dictionary'))
            assert request('wordFrequencies', {'folder': lists, 'words': ['Today', 'Xyvora', 'สวัสดี']}) == {'zipf': [57, 0, None]}
            request('wordFrequencies', {'folder': lists, 'words': [1]}, refused=True)
            request('wordFrequencies', {'folder': 'dictionary', 'words': ['Today']}, refused=True)
            request('wordFrequencies', {'folder': os.path.join(lists, 'missing'), 'words': ['Today']}, refused=True)
            request('readScreen', refused=True)
            request('focusedFieldValue', {**policy, 'window': 1, 'maxLength': 20000}, refused=True)
        wait_calls((1, 0))
        if reader:
            assert 'First synthetic app' in screen()['renderedText'], 'startup activates the already-foreground app'
        assert command('a') == (2, 0)
        if reader:
            assert 'First synthetic app' in screen()['renderedText']
        elif fields:
            assert field() == {'value': 'Synthetic field content'}
        # The Shell holds the keyboard while the dictation key is down: the focus moves to the Shell
        # and back, and the window in front stays the target, with the same token, throughout. The
        # reader asks the extension too, so a read at the key's press still reads that window.
        window = None if reader or fields else request('frontmostApp')['window']
        command('h')
        if reader:
            assert 'First synthetic app' in screen()['renderedText'], 'the screen is read while the Shell holds the keyboard'
        elif not fields:
            assert request('frontmostApp') == {'window': window, 'pid': first}, 'the target stays while the Shell holds the keyboard'
        if fields:
            assert field() == {'value': 'Synthetic field content'}, 'the field is read while the Shell holds the keyboard'
        elif not reader:
            # The overlay is placed at the target's caret during the hold too (its reply is geometry
            # or null; the categorical diagnostic says whether the target was still the one in front).
            diagnostics.seek(0, os.SEEK_END)
            mark = diagnostics.tell()
            request('caretAnchor', {})
            diagnostics.seek(mark)
            caret = diagnostics.read()
            assert 'debug accessibility: caret ' in caret and 'stale target' not in caret and 'no target' not in caret, \
                'the caret is read for the target while the Shell holds the keyboard'
            # A paste while the Shell holds the keyboard would reach no window: nothing is offered or sent.
            assert request('requestInsertion', {}) == {}, 'the synthetic portal grants keyboard control'
            paste(window, refused=True)
            assert portal_events(0.5) == [], 'no selection or key reaches the portal while the Shell holds the keyboard'
        command('H')
        if fields:
            assert field() == {'value': 'Synthetic field content'}, 'the field is read after the hold'
        elif not reader:
            assert request('frontmostApp') == {'window': window, 'pid': first}, 'the target keeps its token after the hold'
        if not reader and not fields:
            # The same paste once the hold ends goes through: the control for the refusal above.
            paste(window, refused=False)
            assert portal_events(0.5) == ['publish', 'key 65507 1', 'key 118 1', 'key 118 0', 'key 65507 0'], \
                'after the hold the paste is offered and Ctrl+V is sent'
        # Without a hold, the Shell's own window is no target, and the window it took the focus from
        # is no longer one either.
        command('S')
        if reader:
            assert screen() is None, 'the Shell is never read as the target'
        else:
            assert target() is None, 'the Shell is never the target'
        command('H')
        if fields:
            assert field() == {'value': 'Synthetic field content'}
        elif not reader:
            assert request('frontmostApp') == {'window': window, 'pid': first}
        # Gmail's compose box is a dialog in the page, not a window: the focus moving into it keeps the
        # window in front the target, by its token, and the screen read is the whole window's.
        command('w')
        if reader:
            read = screen()['renderedText']
            assert 'First synthetic app' in read and 'Synthetic compose content' in read, 'a web dialog is read with its window'
        elif fields:
            assert field() == {'value': 'Synthetic compose content'}, "the dialog's field is read"
        else:
            assert request('frontmostApp') == {'window': window, 'pid': first}, 'a web dialog keeps its window as the target'
        command('W')
        if fields:
            assert field() == {'value': 'Synthetic field content'}
        elif not reader:
            assert request('frontmostApp') == {'window': window, 'pid': first}
        # A GTK 4 window drops its field's focus while the Shell holds the keyboard (GNOME Text
        # Editor): the selection read at the key's press is still the field's, not withheld.
        command('l')
        command('h')
        if reader:
            read = screen()
            assert read['selectionRedacted'] is False and read['selectedText'] == 'x' * 20001, \
                'the selection is read while the Shell holds the keyboard'
        command('H')
        for mode in ('l', 'v'):
            command(mode)
            if reader:
                read = screen()
                assert read['selectedText'] == 'x' * 20001, 'native acquisition preserves the entire long selection'
                assert read['selectionRedacted'] is False
                assert len(read['textBeforeCaret']) <= 2000 and len(read['textAfterCaret']) <= 2000
        command('t')
        for mode in ('l', 'v', 'c', 'q', 'U'):
            command(mode)
            if reader:
                read = screen()
                expected = '[redacted]' if mode in ('q', 'U') else ('😀e\u0301' * 7000 if mode == 'c' else 'x' * 20001)
                assert read['selectedText'] == expected, 'terminal selection uses common complete-or-refuse policy'
                assert read['selectionRedacted'] is (mode in ('q', 'U'))
                assert read['textBeforeCaret'] == '' and read['textAfterCaret'] == '', 'terminal selection never publishes adjacent source'
        command('l')
        command('m')
        if reader:
            read = screen()
            # A terminal keeps what it read at key-down, even if the selection moves meanwhile (owner, 2026-10-05).
            assert read['selectionRedacted'] is False and read['selectedText'] == 'x' * 20001, 'changed terminal selection keeps the key-down read'
        command('z')
        command('c')
        if reader:
            read = screen()
            assert read['selectedText'] == '😀e\u0301' * 7000, 'native chunk boundaries preserve non-BMP and combining text'
            assert read['selectionRedacted'] is False
        command('m')
        if reader:
            read = screen()
            assert read['selectionRedacted'] is True and read['selectedText'] == '[redacted]', 'changed selection uses the shared refusal marker and disables Edit'
        for mode in ('q', 'U'):
            command(mode)
            if reader:
                read = screen()
                assert read['selectionRedacted'] is True and read['selectedText'] == '[redacted]', 'scalar or UTF-8 oversized selection uses the shared refusal marker, never a prefix'
        command('z')
        command('f')
        if reader:
            assert screen() is None, 'foreground change during text read refuses stale screen'
        elif fields:
            assert field() is None, 'foreground change during field read refuses stale correction text'
        command('g')
        # A different app gets its own activation request, without an identity allowlist.
        assert command('b') == (2, 1)
        if reader:
            assert 'Second synthetic app' in screen()['renderedText']
        elif fields:
            # The field pasted into is the first app's: with the second in front, nothing is read; the
            # second app's own field is read by its process. A window token names nothing here.
            assert field(first) is None, 'another app in front is never read for the app pasted into'
            assert field(second) == {'value': 'Synthetic field content'}, 'the app in front is read by its process'
            for named in ({'window': 1}, {'pid': -1}, {'pid': str(second)}, {'pid': 0}, {}):
                assert request('focusedFieldValue', {**policy, **named, 'maxLength': 20000}) is None, f'no field for {named}'
        else:
            assert request('frontmostApp')['pid'] == second, "the helper names the second app's process"
        # Each real consumer must refresh children added after its cached preflight.
        command('p')
        if reader:
            read = screen()
            assert read['textBeforeCaret'] == '' and 'synthetic-private-password' not in json.dumps(read)
        command('u')
        if fields:
            assert field(second) == {'value': 'Synthetic field content'}
            command('p')
            assert field(second) == {'value': None}
            command('u')
            assert field(second) == {'value': 'Synthetic field content'}
        excluded = {**policy, 'excludedHosts': ['synthetic.example']}
        if reader:
            assert screen(excluded) == {'hidden': True}
        elif fields:
            assert request('focusedFieldValue', {**excluded, 'pid': second, 'maxLength': 20000}) == {'value': None}
        # A failed request recovers via the actual one-second timer.
        assert command('r') == (3, 1)
        assert (screen() if reader else target()) is None
        wait_calls((4, 1))
        if reader:
            assert 'First synthetic app' in screen()['renderedText']
        else:
            assert target()
        time.sleep(1.1)
        assert command('s') == (4, 1), 'successful activation must stop retries'
        # An unavailable provider gets five attempts, then a new visit can recover.
        assert command('e') == (5, 1)
        wait_calls((9, 1))
        time.sleep(1.1)
        assert command('s') == (9, 1) and (screen() if reader else target()) is None
        assert command('a') == (10, 1)
        if fields:
            assert field() == {'value': 'Synthetic field content'}
        # An app that announces its field before its window, then a container around the field.
        assert command('o') == (10, 1), 'a field announced before its window needs no lookup'
        assert target(), 'the field, not its container, stays the target'
        assert command('e') == (11, 1)
        command('d')
        time.sleep(1.1)
        assert command('s') == (11, 1)
        if not reader:
            assert target() is None, 'departure cancels retries'
        if not reader and not fields:
            command('a')
            window = request('frontmostApp')['window']
            # Firefox announces its window before its field's focus as the Shell lets the keyboard go: the
            # target stays, and the walk for the focus waits a second for it to come back by itself.
            before = command('s')
            command('h')
            command('J')
            command('G')
            time.sleep(1.1)
            assert command('s') == before, 'a focus back within the wait is not looked for'
            assert request('frontmostApp') == {'window': window, 'pid': first}, 'the target stays through the hold'
            command('h')
            command('J')
            time.sleep(1.1)
            assert command('s') == (before[0] + 1, before[1]), 'a focus still away after the wait is looked for'
            command('G')
            assert request('frontmostApp') == {'window': window, 'pid': first}, 'the target is the same once its focus is back'
            # Where the Shell says which window has the focus, that window is the target, by the Shell's
            # id, whatever the focus does meanwhile: while the Shell holds the keyboard, and back again.
            command('F')
            assert request('frontmostApp') == {'window': 7000, 'pid': first}, "the Shell's window id names the target"
            command('h')
            assert request('frontmostApp') == {'window': 7000, 'pid': first}, 'the target stays while the Shell holds the keyboard'
            command('H')
            command('b')
            assert request('frontmostApp') == {'window': 7001, 'pid': second}
            command('a')
            assert request('frontmostApp') == {'window': 7000, 'pid': first}
            command('N')
        # Where the Shell says which window is in front, a focus another app announces meanwhile is not
        # taken for it: nothing is read until the focus is that window's process's again.
        command('a')
        command('F')
        if reader:
            assert 'First synthetic app' in screen()['renderedText']
        elif fields:
            assert field() == {'value': 'Synthetic field content'}
        command('x')
        if reader:
            assert screen() is None, "another app's focus is not read as the window the Shell names"
        elif fields:
            assert field(second) is None and field() is None, "another app's field is not read as the window the Shell names"
        # Nor while the Shell holds the keyboard, when a field the hold took the focus from is still read.
        command('h')
        if reader:
            assert screen() is None, "another app's focus is not read as the window the Shell names during the hold"
        elif fields:
            assert field(second) is None and field() is None, "another app's field is not read as the window the Shell names during the hold"
        else:
            assert request('frontmostApp') == {'window': 7000, 'pid': first}, "another app is not the window the Shell names during the hold"
            paste(7000, refused=True)
            assert portal_events(0.5) == [], "nothing is pasted for another app's focus during the hold"
        command('H')
        # The Shell gives the focus back to the field in the window it names now (7000). While the Shell
        # holds the keyboard over it, the field is still read (GTK 4 drops its focus meanwhile), and
        # nothing is pasted; once the Shell lets go, the paste goes through.
        command('h')
        if reader:
            assert 'First synthetic app' in screen()['renderedText'], 'the screen is read while the Shell holds the keyboard over its window'
        elif fields:
            assert field() == {'value': 'Synthetic field content'}, 'the field is read while the Shell holds the keyboard over its window'
        else:
            assert request('frontmostApp') == {'window': 7000, 'pid': first}
            paste(7000, refused=True)
            assert portal_events(0.5) == [], 'nothing is pasted while the Shell holds the keyboard over the window it names'
        command('H')
        if not reader and not fields:
            paste(7000, refused=False)
            assert portal_events(0.5) == ['publish', 'key 65507 1', 'key 118 1', 'key 118 0', 'key 65507 0'], \
                'once the Shell lets go, the paste goes to the window it names'
        # The Shell names another window of the same app before that app says what has its focus: the
        # field the focus came in is that other window's no more, a hold over it changes nothing, and a
        # paste for the first window waits.
        command('k')
        for held in ('', 'h'):
            if held:
                command(held)
            if reader:
                assert screen() is None, "a field of the app's other window is not read as the window the Shell names"
            elif fields:
                assert field() is None, "a field of the app's other window is not read as the window the Shell names"
            else:
                # During the hold the Shell's window is the one in front; past it, a window whose focus
                # the app has not named yet is not the target. Either way a paste for the first one waits.
                expected = {'window': 7100, 'pid': first} if held else None
                assert request('frontmostApp') == expected, 'the window in front is the one the Shell names, or none'
                paste(7000, refused=True)
                assert portal_events(0.5) == [], 'a paste is not sent to another window of the app'
        command('H')
        command('K')
        # The Shell says no window has the focus (a locked screen): nothing is in front, read or pasted
        # into, whatever accessibility last said; it all comes back with the window.
        command('L')
        if reader:
            assert screen() is None, 'nothing is read while the Shell says no window has the focus'
        elif fields:
            assert field() is None, 'no field is read while the Shell says no window has the focus'
        else:
            assert request('frontmostApp') is None, 'nothing is in front while the Shell says no window has the focus'
            paste(7000, refused=True)
            assert portal_events(0.5) == [], 'nothing is pasted while the Shell says no window has the focus'
        command('K')
        if reader:
            assert 'First synthetic app' in screen()['renderedText'], 'reads come back with the window'
        elif fields:
            assert field() == {'value': 'Synthetic field content'}, 'field reads come back with the window'
        else:
            assert request('frontmostApp') == {'window': 7000, 'pid': first}, 'the window in front comes back'
        # The Shell names a window of a process accessibility doesn't know (a terminal with no
        # accessibility): what in it has the focus, and so which keys paste there, is unknown. It is not
        # the target (the app shows its note), and nothing is read from it or pasted into it.
        command('V')
        if reader:
            assert screen() is None, 'a window accessibility does not know is not read'
        elif fields:
            assert field() is None and field(4194399) is None, 'a window accessibility does not know has no field read'
        else:
            assert request('frontmostApp') is None, 'a window accessibility does not know is not the target'
            paste(7200, refused=True)
            # Named at the dictation key's press (the Shell holds the keyboard), it is no target once let go.
            command('h')
            holding_reply = request('frontmostApp')
            command('H')
            assert holding_reply == {'window': 7200, 'pid': 4194399}, "the Shell's window is the one in front while it holds the keyboard"
            assert request('frontmostApp') is None, 'once the Shell lets go, a window accessibility does not know is not the target'
            assert portal_events(0.5) == [], 'no key goes to a window whose focus accessibility does not name'
        command('K')
        # The Shell's own interface takes the focus from the window it still names (the overview, when
        # the extension can't say otherwise): the Shell is never the target, and nothing is pasted.
        command('S')
        if reader:
            assert screen() is None, 'the Shell is never read as the target'
        elif fields:
            assert field() is None, 'the Shell is never read as the target'
        else:
            paste(7000, refused=True)
            assert portal_events(0.5) == [], 'no key goes to the Shell over the window it names'
        command('H')
        if not reader and not fields:
            paste(7000, refused=False)
            assert portal_events(0.5) == ['publish', 'key 65507 1', 'key 118 1', 'key 118 0', 'key 65507 0'], \
                'with the focus back in the window, the paste goes to it'
        # The window in front gives up its focus with no hold yet (Firefox, as the dictation key's hold
        # begins): where the Shell still names it, it stays the target.
        command('D')
        if reader:
            assert 'First synthetic app' in screen()['renderedText'], 'a window the Shell still names is read after it gives up its focus'
        elif fields:
            assert field() == {'value': 'Synthetic field content'}, "the field of a window the Shell still names is read after it gives up its focus"
        else:
            assert request('frontmostApp') == {'window': 7000, 'pid': first}, 'a window the Shell still names stays the target after it gives up its focus'
        # The dictation key pressed with Voice's own window in front: the capture is the last other app's
        # window, by the Shell's id for it, the id a captured read asks the Shell to name its app by.
        if not reader and not fields:
            command('b')
            command('a')
            command('M')
            assert request('captureTarget') == {'window': 7000, 'pid': first, 'bus': ':1.synthetic-0',
                'path': '/org/a11y/atspi/accessible/window0'}, "a capture with Voice in front is the last app's window, by the Shell's id"
            command('K')
        # A sandboxed app (Flatpak) reaches accessibility through its bus proxy, whose process the Shell
        # never names: its window is still the target, read and pasted into, by the window in front as its
        # focus came.
        command('P')
        command('b')
        command('a')
        if reader:
            assert 'First synthetic app' in screen()['renderedText'], "a sandboxed app's window is read"
        elif fields:
            assert field(proxy.pid) == {'value': 'Synthetic field content'}, "a sandboxed app's field is read"
        else:
            assert request('frontmostApp') == {'window': 7000, 'pid': proxy.pid}, "a sandboxed app's window is the target"
            paste(7000, refused=False)
            assert portal_events(0.5) == ['publish', 'key 65507 1', 'key 118 1', 'key 118 0', 'key 65507 0'], \
                "the paste goes to a sandboxed app's window"
        command('R')
        command('N')
        if reader:
            # A whole-window read bound to an earlier read (`sameWindowAs`) reads that read's window only
            # while that read is the last one numbered and its window is still the one in front; else null.
            def bound(read, to):
                return request('readScreen', {**policy, 'read': read, 'wholeWindow': True, 'sameWindowAs': to})
            command('a')
            # Reading the whole window, the focused field is read whole like any field, after the caret
            # block that marks it; none of the caret's text is sent apart from it.
            shown_read, whole = screen(), screen({**policy, 'wholeWindow': True})
            assert shown_read['textBeforeCaret'] == 'Synthetic field content', 'what the window shows keeps the text around the caret'
            assert [whole['textBeforeCaret'], whole['selectedText'], whole['textAfterCaret']] == ['', '', ''], \
                "the whole window keeps none of the caret's text"
            text = whole['renderedText']
            assert '» ‸' in text and '> Synthetic field content' in text[text.index('» ‸'):], \
                'the whole window reads the focused field whole, just after its caret block'
            assert 'First synthetic app' in screen({**policy, 'read': 2})['renderedText']
            assert 'First synthetic app' in bound(3, 2)['renderedText'], 'the same window, still in front, is read'
            assert bound(4, 2) is None, 'a read bound to one that is no longer the last numbered is not read'
            assert screen({**policy, 'read': 5})
            command('w')
            read = bound(6, 5)
            assert read and 'Synthetic compose content' in read['renderedText'], 'the focus moving within the window keeps it the same window'
            command('W')
            assert screen({**policy, 'read': 7})
            command('b')
            assert bound(8, 7) is None, 'another app in front is not read in its place'
            command('a')
            assert bound(9, 7) is None, 'nor the window come to the front anew: accessibility gives it a new token'
            # Where the Shell names the window, by its own id: another window of the same app named in
            # front is not read in its place, and the read's window named again is.
            command('F')
            assert 'First synthetic app' in screen({**policy, 'read': 10})['renderedText']
            command('k')
            assert bound(11, 10) is None, "another window of the app is not read in the read's place"
            command('K')
            assert 'First synthetic app' in bound(12, 10)['renderedText'], "the read's window named in front again is read"
            command('N')
        # Which app a window is: where the Shell names the window, its window tracker names the app, whatever
        # the app's process says (snap Chromium's names none), and an app excluded by that name is not read.
        # Without the Shell, or for a window the Shell knows no desktop file for, the process's launcher names
        # it: none for the synthetic processes, so nothing is excluded by that name.
        shell_first = 'ai.tabmail.SyntheticFirst.desktop'

        # Whether the helper logged this line (read through a handle of its own: its stderr shares the file's offset).
        def logged(line):
            with open(f'/proc/self/fd/{diagnostics.fileno()}') as log:
                return line in log.read()

        def identity():
            if reader:
                read = screen()
                return read['bundleID'], read['appName']
            return None

        def refused(app_id=shell_first, pid=first):
            excluded = {**policy, 'excludedAppIDs': [app_id]}
            if reader:
                return screen(excluded) == {'hidden': True}
            if fields:
                return request('focusedFieldValue', {**excluded, 'pid': pid, 'maxLength': 20000}) == {'value': None} \
                    and field(pid) == {'value': 'Synthetic field content'}
            return None

        # Whether a read gave nothing at all, as one the Shell gave no answer for does.
        def unanswered(pid=first):
            if reader:
                return screen() is None
            if fields:
                return request('focusedFieldValue', {**policy, 'pid': pid, 'maxLength': 20000}) is None
            return None

        command('b')
        command('a')
        assert identity() in (('', 'Unknown'), None), 'without the Shell, a process no launcher names is unnamed'
        assert not refused(), 'without the Shell, the name only the Shell knows excludes nothing'
        # The focus came before the Shell named its window: the window is named by the Shell once it does.
        command('F')
        assert identity() in ((shell_first, 'First synthetic app'), None), "the Shell names the window's app"
        assert refused() in (True, None), "an app excluded by the Shell's name for it is not read"
        command('b')
        assert identity() in (('', 'Unknown'), None), 'a window the Shell knows no desktop file for is named by its process'
        command('a')
        assert identity() in ((shell_first, 'First synthetic app'), None), "a focus in the window the Shell names is the Shell's app"
        assert refused() in (True, None), "an app excluded by the Shell's name for it is not read"
        # The Shell is asked at each read: the name it now gives the window is the one read.
        command('T')
        command('w')
        assert identity() in (('ai.tabmail.SyntheticRenamed.desktop', 'Renamed synthetic app'), None), "a focus in the window takes the Shell's name for it then"
        command('W')
        command('Y')
        command('N')
        # A Shell that gives no answer for the window in front gives no read, whatever is excluded; the next
        # read asks it again. The focus is moved away and back so it is remembered anew (the window already in
        # front, activated again, shows no focus until its focus is looked for again), and the read is shown to
        # succeed in that state first, so the reads that give nothing give it for the Shell's silence alone.
        command('F')
        command('b')
        command('a')
        assert identity() in ((shell_first, 'First synthetic app'), None), "the Shell names the window's app"
        command('X')
        assert unanswered() in (True, None), 'a read the Shell gives no answer for gives nothing'
        assert unanswered() in (True, None), 'nor does the next while it gives none'
        command('Z')
        assert identity() in ((shell_first, 'First synthetic app'), None), 'the next read asks the Shell again'
        assert refused() in (True, None), "an app excluded by the Shell's name for it is not read"
        # A focus that came before the Shell named its window, read while the Shell's Focus gives no answer: the
        # Shell is asked for the app with no window id of its own, has no live window for it, and the read gives
        # nothing; the launcher does not stand in.
        command('N')
        command('b')
        command('a')
        assert identity() in (('', 'Unknown'), None), 'without the Shell, the focus is read, named by its process'
        command('F')
        command('Q')
        assert unanswered() in (True, None), 'a read with no Shell window id, while the Shell answers, gives nothing'
        command('K')
        command('b')
        command('a')
        assert identity() in ((shell_first, 'First synthetic app'), None), 'the Shell names the window again once its Focus answers'
        # A focus remembered in the window the Shell named, read while its Focus gives no answer: the Shell's id
        # for the window is asked, and the app it names is the one read, and excluded.
        command('Q')
        assert identity() in ((shell_first, 'First synthetic app'), None), "a focus remembered in the Shell's window is named by the Shell"
        assert refused() in (True, None), "an app excluded by the Shell's name for it is not read"
        command('K')
        if reader:
            # A window captured at key-down, read while another is in front: named by the Shell from its id for
            # the window, not read where that app is excluded, and not read where the Shell gives no answer.
            captured = {'window': 7000, 'pid': first, 'bus': ':1.synthetic-0', 'path': '/org/a11y/atspi/accessible/window0'}
            command('b')
            read = screen({**policy, 'target': captured})
            assert (read['bundleID'], read['appName']) == (shell_first, 'First synthetic app'), 'a captured window is named by the Shell'
            assert screen({**policy, 'excludedAppIDs': [shell_first], 'target': captured}) == {'hidden': True}, \
                "a captured window of an app excluded by the Shell's name for it is not read"
            command('X')
            assert screen({**policy, 'target': captured}) is None, 'a captured window the Shell gives no answer for is not read'
            assert logged("error screen: the Shell did not name the captured window's app"), \
                'a captured read the Shell gave no answer for is logged as an error'
            command('E')
            read = screen({**policy, 'target': captured})
            assert (read['bundleID'], read['appName']) == ('', 'Unknown'), 'a captured window the Shell names no app for is named by its process'
            command('Z')
            # An id that is none of the Shell's live windows (the helper's own token, captured while the Shell named
            # no window, or a window closed since): the Shell says it has no such window, the launcher does not
            # stand in, and nothing is read, excluded or not.
            token = {**captured, 'window': 123456789}
            assert screen({**policy, 'excludedAppIDs': [shell_first], 'target': token}) is None, \
                'a captured id the Shell has no live window for is not read where its app is excluded'
            assert screen({**policy, 'target': token}) is None, 'nor where nothing is excluded'
            command('a')
        # The Shell's name first, the launcher's only where the Shell names none: the first app is now a process
        # its launcher names another app.
        command('A')
        command('b')
        command('a')
        assert identity() in ((shell_first, 'First synthetic app'), None), "the Shell's name wins over the launcher's"
        assert not refused(launched_id, launched.pid), "the launcher's name for an app the Shell names excludes nothing"
        assert refused(shell_first, launched.pid) in (True, None), "an app excluded by the Shell's name for it is not read"
        for answer in ('E', 'O'):
            # The Shell names no app for the window, or its extension is older than App (until the next log-in).
            command(answer)
            assert identity() in ((launched_id, 'Launched synthetic app'), None), 'where the Shell names no app, its launcher names it'
            assert refused(launched_id, launched.pid) in (True, None), "an app excluded by its launcher's name is not read"
        command('X')
        assert unanswered(launched.pid) in (True, None), 'where the Shell gives no answer, the launcher does not name the app'
        if reader or fields:
            assert logged('error screen: the Shell did not name the app in front'), 'a read the Shell gave no answer for is logged as an error'
        command('Z')
        command('N')
        assert identity() in ((launched_id, 'Launched synthetic app'), None), 'without the Shell, the launcher names the app'
        command('I')
        command('a')
        print(f"native foreground activation, two apps, retry recovery/exhaustion/cancellation and the {'screen reads' if reader else 'field reads' if fields else 'caret and paste'} passed")
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        os.close(control_write)
        acknowledgments.close()
        portal.stdin.close()
        portal.wait(timeout=2)
        proxy.kill()
        proxy.wait()
        launched.kill()
        launched.wait()
        proxy_dir.cleanup()
        if child.returncode:
            diagnostics.seek(0)
            sys.stderr.write(diagnostics.read())
        assert child.returncode == 0, "native service must exit cleanly after parent EOF"
