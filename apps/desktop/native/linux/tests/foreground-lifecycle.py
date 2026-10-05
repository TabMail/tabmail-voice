# This Source Code Form is subject to the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Drive the real native service through foreground callbacks and GLib timers."""
import json
import os
import select
import subprocess
import sys
import tempfile
import time

control_read, control_write = os.pipe()
ack_read, ack_write = os.pipe()
with tempfile.TemporaryFile(mode='w+t') as diagnostics:
    child = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=diagnostics, text=True, pass_fds=(control_read, ack_write), env={**os.environ,
        'VOICE_FIXTURE_CONTROL': str(control_read), 'VOICE_FIXTURE_ACK': str(ack_write)})
    os.close(control_read)
    os.close(ack_write)
    acknowledgments = os.fdopen(ack_read)
    sequence = 0
    policy = {'excludedAppIDs': [], 'excludedHosts': []}

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

    def field():
        target = request('frontmostApp')
        assert target and target['window'] > 0
        return request('focusedFieldValue', {**policy, 'window': target['window'], 'maxLength': 20000})

    try:
        request('frontmostApp')
        wait_calls((1, 0))
        assert 'First synthetic app' in request('readScreen')['renderedText'], 'startup activates the already-foreground app'
        assert command('a') == (2, 0)
        assert 'First synthetic app' in request('readScreen')['renderedText']
        assert field() == {'value': 'Synthetic field content'}
        for mode in ('l', 'v'):
            command(mode)
            screen = request('readScreen')
            assert screen['selectedText'] == 'x' * 20001, 'native acquisition preserves the entire long selection'
            assert screen['selectionRedacted'] is False
            assert len(screen['textBeforeCaret']) <= 2000 and len(screen['textAfterCaret']) <= 2000
        command('t')
        for mode in ('l', 'v', 'c', 'q', 'U'):
            command(mode)
            screen = request('readScreen')
            expected = '[redacted]' if mode in ('q', 'U') else ('😀é' * 7000 if mode == 'c' else 'x' * 20001)
            assert screen['selectedText'] == expected, 'terminal selection uses common complete-or-refuse policy'
            assert screen['selectionRedacted'] is (mode in ('q', 'U'))
            assert screen['textBeforeCaret'] == '' and screen['textAfterCaret'] == '', 'terminal selection never publishes adjacent source'
        command('l')
        command('m')
        screen = request('readScreen')
        assert screen['selectionRedacted'] is True and screen['selectedText'] == '[redacted]', 'changed terminal selection is unavailable'
        command('z')
        command('c')
        screen = request('readScreen')
        assert screen['selectedText'] == '😀é' * 7000, 'native chunk boundaries preserve non-BMP and combining text'
        assert screen['selectionRedacted'] is False
        command('m')
        screen = request('readScreen')
        assert screen['selectionRedacted'] is True and screen['selectedText'] == '[redacted]', 'changed selection uses the shared refusal marker and disables Edit'
        for mode in ('q', 'U'):
            command(mode)
            screen = request('readScreen')
            assert screen['selectionRedacted'] is True and screen['selectedText'] == '[redacted]', 'scalar or UTF-8 oversized selection uses the shared refusal marker, never a prefix'
        command('z')
        command('f')
        assert request('readScreen') is None, 'foreground change during text read refuses stale screen'
        command('g')
        command('f')
        assert field() is None, 'foreground change during field read refuses stale correction text'
        command('g')
        # A different app gets its own activation request, without an identity allowlist.
        assert command('b') == (2, 1)
        assert 'Second synthetic app' in request('readScreen')['renderedText']
        # Each real consumer must refresh children added after its cached preflight.
        command('p')
        screen = request('readScreen')
        assert screen['textBeforeCaret'] == '' and 'synthetic-private-password' not in json.dumps(screen)
        command('u')
        assert field() == {'value': 'Synthetic field content'}
        command('p')
        assert field() == {'value': None}
        command('u')
        assert field() == {'value': 'Synthetic field content'}
        excluded = {**policy, 'excludedHosts': ['synthetic.example']}
        assert request('readScreen', excluded) == {'hidden': True}
        target = request('frontmostApp')['window']
        assert request('focusedFieldValue', {**excluded, 'window': target, 'maxLength': 20000}) == {'value': None}
        # A failed request recovers via the actual one-second timer.
        assert command('r') == (3, 1)
        assert request('readScreen') is None
        wait_calls((4, 1))
        assert 'First synthetic app' in request('readScreen')['renderedText']
        time.sleep(1.1)
        assert command('s') == (4, 1), 'successful activation must stop retries'
        # An unavailable provider gets five attempts, then a new visit can recover.
        assert command('e') == (5, 1)
        wait_calls((9, 1))
        time.sleep(1.1)
        assert command('s') == (9, 1) and request('readScreen') is None
        assert command('a') == (10, 1)
        assert field() == {'value': 'Synthetic field content'}
        # An app that announces its field before its window, then a container around the field.
        assert command('o') == (10, 1), 'a field announced before its window needs no lookup'
        assert request('frontmostApp'), 'the field, not its container, stays the target'
        assert command('e') == (11, 1)
        command('d')
        time.sleep(1.1)
        assert command('s') == (11, 1) and request('frontmostApp') is None, 'departure cancels retries'
        print('native foreground activation, two apps, retry recovery/exhaustion/cancellation and both read consumers passed')
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        os.close(control_write)
        acknowledgments.close()
        if child.returncode:
            diagnostics.seek(0)
            sys.stderr.write(diagnostics.read())
        assert child.returncode == 0, "native service must exit cleanly after parent EOF"
