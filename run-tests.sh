#!/bin/bash
# Run the test suite. The sources live under src/ but the tests use the deployed *flat* layout
# (`require('../watchers.js')`), matching ~/.claude/agent-dashboard/. So flatten src/ into a temp
# dir, copy test/ alongside, and run there. Zero impact on the live agent-dashboard server.
#
#   ./run-tests.sh                       # whole suite
#   ./run-tests.sh test/watchers.test.js # one file (path relative to repo/flat root)
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"

# Kill leaked cockpit servers squatting the 39xx test ports (never 3847 — the live server).
# A leftover listener makes port-fixed tests silently talk to the WRONG server and fail with
# baffling assertion diffs. Only processes running a cockpit server.js are touched.
for pid in $(lsof -nP -tiTCP:3899-3963 -sTCP:LISTEN 2>/dev/null); do
  if ps -o args= -p "$pid" 2>/dev/null | grep -q "server\.js"; then
    echo "Killing leaked test server pid $pid ($(ps -o args= -p "$pid" | head -c 80))"
    kill "$pid" 2>/dev/null || true
  fi
done
T="$(mktemp -d "${TMPDIR:-/tmp}/ckwt.XXXXXX")"
trap 'rm -rf "$T"' EXIT
cp -R "$REPO/src/." "$T/"            # src contents incl. the watchers/ subdir -> flat root
rm -rf "$T/test"; cp -R "$REPO/test" "$T/test"
cd "$T"
if [ "$#" -gt 0 ]; then FILES="$*"; else FILES="$(ls test/*.test.js)"; fi
export CK_REPO_ROOT="$REPO"
# Model discovery must never consult real provider CLIs/catalogs in tests.
export CK_MODELS_DISABLE_REFRESH=1
export CK_MODELS_CACHE="$T/model-fixtures/missing-cache.json"
export CK_CLAUDE_CATALOG_DIR="$T/model-fixtures/claude"
export CK_CODEX_BIN="$T/model-fixtures/no-codex"
export CK_CODEX_MODELS_CACHE="$T/model-fixtures/no-codex-cache.json"
export CK_CODEX_CONFIG="$T/model-fixtures/no-config.toml"
export CK_AGY_BIN="$T/model-fixtures/no-agy"
node --test $FILES
