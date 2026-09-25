#!/bin/sh
# Generate the Xcode project with code signing wired up.
#
# DEVELOPMENT_TEAM is kept OUT of the repo. It lives in the gitignored
# LocalSigning.xcconfig (create it from LocalSigning.xcconfig.example).
# project.yml references it as ${DEVELOPMENT_TEAM}; this wrapper extracts that
# one value and exports it. ALWAYS run this instead of a bare `xcodegen generate`:
# with the var unset, XcodeGen writes the literal "${DEVELOPMENT_TEAM}" into the
# project.
set -eu

cd "$(dirname "$0")/.."

team=""
if [ -f LocalSigning.xcconfig ]; then
  team="$(awk -F= '/^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}' LocalSigning.xcconfig)"
fi

if [ -z "$team" ]; then
  echo "warning: DEVELOPMENT_TEAM not found in LocalSigning.xcconfig — generating with an empty team." >&2
  echo "         Builds will be ad-hoc signed, and macOS drops the Accessibility and" >&2
  echo "         Microphone grants on every rebuild." >&2
fi

export DEVELOPMENT_TEAM="$team"
exec xcodegen generate "$@"
