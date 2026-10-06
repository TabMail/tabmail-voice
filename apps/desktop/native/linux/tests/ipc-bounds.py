# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
import json
import selectors
import subprocess
import sys

executable = sys.argv[1]

def stop(child):
    if child.poll() is None:
        child.kill()
    child.wait(timeout=2)
    for pipe in [child.stdin, child.stdout, child.stderr]:
        if pipe and not pipe.closed:
            pipe.close()

# The same executable must first prove that valid requests work.
child = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
try:
    child.stdin.write(b'{"id":1,"method":"echo","params":{"synthetic":"positive"}}\n')
    with selectors.DefaultSelector() as ready:
        ready.register(child.stdout, selectors.EVENT_READ)
        assert ready.select(2), "valid request did not reply"
        assert json.loads(child.stdout.readline()) == {"id": 1, "result": {"synthetic": "positive"}}
    child.stdin.close()
    assert child.wait(timeout=2) == 0
finally:
    stop(child)

child = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
try:
    sent = 0
    try:
        while sent < 2 * 1024 * 1024:
            sent += child.stdin.write(b'x' * 4096)
    except BrokenPipeError:
        pass
    assert sent >= 1024 * 1024, "fixture did not reach the input limit"
    assert child.wait(timeout=2) == 1, "oversized input must terminate before cleanup"
finally:
    stop(child)

child = subprocess.Popen([executable, "--flood"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
try:
    with selectors.DefaultSelector() as ready:
        ready.register(child.stdout, selectors.EVENT_READ)
        assert ready.select(2), "producer did not reach the output path"
        first = json.loads(child.stdout.readline())
    assert first == {"sequence": 0, "payload": "x" * 4096}, "producer did not reach the output path"
    child.stdin.write(b"\n")
    # Leave stdout unread from here on to model a parent that no longer drains output.
    assert child.wait(timeout=2) == 1, "output backpressure must terminate before cleanup"
    assert b'enqueued400' not in child.stderr.read(), "producer exceeded the bounded queue"
finally:
    stop(child)
print("Valid IPC, oversized input and blocked-output bounds passed")
