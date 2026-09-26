#!/bin/sh
# Generate the Xcode project with code signing wired up.
#
# DEVELOPMENT_TEAM is intentionally kept OUT of the public repo. It lives in the
# gitignored Secrets.xcconfig at the repository root (every dev creates it from
# Secrets.xcconfig.example there). project.yml references it as ${DEVELOPMENT_TEAM};
# this wrapper extracts that one value and exports it. ALWAYS run this instead of a
# bare `xcodegen generate`: with the var unset, XcodeGen writes the literal
# "${DEVELOPMENT_TEAM}" into the project.
set -eu

cd "$(dirname "$0")/.."
config=../../Secrets.xcconfig

if [ ! -f "$config" ]; then
  echo "error: Secrets.xcconfig not found at the repository root. Create it from the template:" >&2
  echo "         cp Secrets.xcconfig.example Secrets.xcconfig   (in the repository root)" >&2
  echo "       then set DEVELOPMENT_TEAM (see the comments in the template)." >&2
  exit 1
fi

team="$(awk -F= '/^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}' "$config")"

if [ -z "$team" ] || [ "$team" = "YOUR_TEAM_ID" ]; then
  echo "warning: DEVELOPMENT_TEAM not set in Secrets.xcconfig — generating with an empty team." >&2
  echo "         Builds will be ad-hoc signed, and macOS drops the Accessibility and" >&2
  echo "         Microphone grants on every rebuild." >&2
  team=""
fi

export DEVELOPMENT_TEAM="$team"
exec xcodegen generate "$@"
