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
with tempfile.TemporaryFile(mode='w+t') as diagnostics:
    reader = sys.argv[2:] == ['reader']
    fields = sys.argv[2:] == ['field']
    assert sys.argv[2:] in ([], ['reader'], ['field'])
    child = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=diagnostics, text=True, pass_fds=(control_read, ack_write), env={**os.environ,
        'VOICE_FIXTURE_CONTROL': str(control_read), 'VOICE_FIXTURE_ACK': str(ack_write)})
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
            for method in ('frontmostApp', 'focusedFieldValue', 'caretAnchor', 'insert', 'redactText'):
                request(method, refused=True)
        elif fields:
            # Asked the moment the field reader starts, as the app does after restarting it when a new
            # watch's read supersedes one still going: the answer waits for the reader to find what has focus.
            assert field() == {'value': 'Synthetic field content'}, 'a read sent as the field reader starts finds the app in front'
            for method in ('frontmostApp', 'readScreen', 'caretAnchor', 'insert', 'redactText', 'requestInsertion'):
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
            # A window the focus comes back to keeps its token: Firefox moves the focus through a
            # second accessible app of its own and back as the Shell lets the keyboard go, and a new
            # token made every paste "another app is in front".
            command('a')
            window = request('frontmostApp')['window']
            command('b')
            assert request('frontmostApp')['window'] != window
            command('a')
            assert request('frontmostApp') == {'window': window, 'pid': first}, 'a window keeps its token when the focus comes back'
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
        command('a')
        command('N')
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
        if child.returncode:
            diagnostics.seek(0)
            sys.stderr.write(diagnostics.read())
        assert child.returncode == 0, "native service must exit cleanly after parent EOF"
