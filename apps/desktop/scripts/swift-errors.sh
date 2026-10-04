#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Runs a SwiftPM command in native/macos and prints only its diagnostics, failures and each test
# run's summary; exits with the command's status.
cd "$(dirname "$0")/../native/macos" || exit 1
case "$(uname -m)" in
  arm64) rust_target=aarch64-apple-darwin ;;
  x86_64) rust_target=x86_64-apple-darwin ;;
  *) exit 1 ;;
esac
(cd ../shared/rust && cargo build --release --locked --target "$rust_target") || exit 1
out=$(swift "$@" 2>&1)
status=$?
printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^/.*(error|warning): |✘|Test run with|passed after|failed after|^error: ' | awk '!/passed after/ || /Test run with/' | sort -u | head -60
exit $status
