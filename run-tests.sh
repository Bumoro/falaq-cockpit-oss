#!/bin/bash
# Run the test suite. The sources live under src/ but the tests use the deployed *flat* layout
# (`require('../watchers.js')`), matching ~/.claude/agent-dashboard/. So flatten src/ into a temp
# dir, copy test/ alongside, and run there. Zero impact on the live agent-dashboard server.
#
#   ./run-tests.sh                       # whole suite
#   ./run-tests.sh test/watchers.test.js # one file (path relative to repo/flat root)
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/ckwt.XXXXXX")"
trap 'rm -rf "$T"' EXIT
cp -R "$REPO/src/." "$T/"            # src contents incl. the watchers/ subdir -> flat root
rm -rf "$T/test"; cp -R "$REPO/test" "$T/test"
cd "$T"
if [ "$#" -gt 0 ]; then FILES="$*"; else FILES="$(ls test/*.test.js)"; fi
export CK_REPO_ROOT="$REPO"
node --test $FILES
