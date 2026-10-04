#!/usr/bin/env python3
"""Verify real Swift wrappers release their Rust allocations after success/refusal."""
import pathlib
import platform
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
native = root / "native/macos"
if "--skip-build" not in sys.argv:
    subprocess.run([str(root / "scripts/swift-errors.sh"), "build"], check=True)
binary_dir = pathlib.Path(subprocess.check_output(
    ["swift", "build", "--package-path", str(native), "--show-bin-path"], text=True).strip())
architecture = {"arm64": "aarch64", "x86_64": "x86_64"}[platform.machine()]
rust = root / f"native/shared/rust/target/{architecture}-apple-darwin/release"
with tempfile.TemporaryDirectory(prefix="voice-ownership-") as directory:
    executable = pathlib.Path(directory) / "ownership"
    subprocess.run([
        "xcrun", "swiftc", "-I", str(binary_dir), "-I", str(native / "Sources/CVoiceCore"),
        str(root / "scripts/macos/fixtures/ownership.swift"),
        str(binary_dir / "VoiceMacOSKit.o"), str(binary_dir / "VoiceHelperSupport.o"),
        "-L", str(rust), "-ltabmail_voice_core", "-o", str(executable),
    ], check=True, timeout=120)
    result = subprocess.run([
        "/usr/bin/leaks", "--noContent", "--atExit", "--", str(executable),
    ], capture_output=True, text=True, timeout=60)
    output = result.stdout + result.stderr
    print(output)
    if (result.returncode != 0 or "NATIVE_OWNERSHIP_PASS 128" not in output
            or "0 leaks for 0 total leaked bytes" not in output):
        raise SystemExit("Native scoped allocation ownership failed")
