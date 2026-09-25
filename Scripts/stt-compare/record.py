#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Record each passage in passages.txt from the system default microphone.

Writes recordings/<id>.wav as 16 kHz mono 16-bit PCM, the format the app uploads.
Press Enter to start a passage and Enter again to stop; type s to skip, r to redo the last one.

    python3 Scripts/stt-compare/record.py            # every passage
    python3 Scripts/stt-compare/record.py 03 08      # only passages whose id starts with 03 or 08
"""
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
RECORDINGS = HERE / "recordings"
SAMPLE_RATE = "16000"


def passages():
    for line in (HERE / "passages.txt").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            pid, text = (part.strip() for part in line.split("|", 1))
            yield pid, text


def record(path: pathlib.Path) -> None:
    # ":default" = the system default input (System Settings › Sound › Input).
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "avfoundation", "-i", ":default",
         "-ac", "1", "-ar", SAMPLE_RATE, "-sample_fmt", "s16", str(path)],
        stdin=subprocess.PIPE,
    )
    input("  ● recording… press Enter to stop ")
    proc.communicate(b"q")  # ffmpeg finishes the file cleanly on "q"


def main() -> None:
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (brew install ffmpeg)")
    RECORDINGS.mkdir(exist_ok=True)
    wanted = sys.argv[1:]
    items = [p for p in passages() if not wanted or any(p[0].startswith(w) for w in wanted)]
    index = 0
    while index < len(items):
        pid, text = items[index]
        print(f"\n[{pid}]  {text}")
        answer = input("  Enter = record, s = skip, r = redo previous: ").strip().lower()
        if answer == "s":
            index += 1
            continue
        if answer == "r" and index > 0:
            index -= 1
            continue
        record(RECORDINGS / f"{pid}.wav")
        index += 1
    print(f"\nDone. Recordings in {RECORDINGS}")


if __name__ == "__main__":
    main()
