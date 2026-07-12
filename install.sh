#!/bin/bash
set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
MIRROR="${CK_MIRROR_DIR:-$HOME/.claude/agent-dashboard}"
SETTINGS="${CK_SETTINGS_FILE:-$HOME/.claude/settings.json}"
PORT="${AGENT_DASHBOARD_PORT:-3847}"
MERGE_HOOKS=0
NO_START=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: ./install.sh [--merge-hooks] [--no-start] [--dry-run]

Install Falaq Cockpit into a local agent-dashboard mirror.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --merge-hooks) MERGE_HOOKS=1 ;;
    --no-start) NO_START=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to install Falaq Cockpit" >&2
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1 || ! command -v claude >/dev/null 2>&1; then
  echo "WARN: controlled New-Chat sessions need tmux + the claude CLI; monitoring works without them" >&2
fi
if [ ! -f "$REPO/files.whitelist" ]; then
  echo "ERROR: missing $REPO/files.whitelist" >&2
  exit 1
fi

WHITELIST="$(cat "$REPO/files.whitelist")"
echo "Falaq Cockpit install"
echo "  repo:     $REPO"
echo "  mirror:   $MIRROR"
echo "  port:     $PORT"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "WOULD create: $MIRROR, $MIRROR/sessions, $MIRROR/watchers"
else
  mkdir -p "$MIRROR" "$MIRROR/sessions" "$MIRROR/watchers"
fi

for f in $WHITELIST; do
  if [ ! -f "$REPO/src/$f" ]; then
    echo "ERROR: missing source file $REPO/src/$f" >&2
    exit 1
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "WOULD sync: src/$f -> $MIRROR/$f"
  else
    mkdir -p "$MIRROR/$(dirname "$f")"
    # Atomic per-file sync prevents an interrupted install leaving truncated code.
    cp -p "$REPO/src/$f" "$MIRROR/$f.deploy-tmp"
    mv "$MIRROR/$f.deploy-tmp" "$MIRROR/$f"
  fi
done

seed() {
  src="$1"
  dest="$2"
  if [ -e "$dest" ]; then
    echo "Preserved existing: $dest"
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "WOULD seed: $dest"
  else
    cp "$src" "$dest.deploy-tmp"
    mv "$dest.deploy-tmp" "$dest"
    echo "Seeded: $dest"
  fi
}
seed "$REPO/src/config.json.template" "$MIRROR/config.json"
seed "$REPO/src/watchers/watcher-config.template.json" "$MIRROR/watchers/watcher-config.json"

# Stamp the repo location so runtime code (the nondev-profile __COCKPIT__ deny floors) can find the
# real source checkout on any machine — teammates may clone anywhere.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "WOULD stamp repo path into $MIRROR/.repo-root"
else
  printf '%s' "$REPO" > "$MIRROR/.repo-root.deploy-tmp"
  mv "$MIRROR/.repo-root.deploy-tmp" "$MIRROR/.repo-root"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$MERGE_HOOKS" -eq 1 ]; then
    echo "WOULD merge cockpit hooks into $SETTINGS"
  else
    echo "WOULD generate hook block at $MIRROR/generated-hooks.json"
  fi
else
  if [ "$MERGE_HOOKS" -eq 1 ]; then
    CK_MIRROR_DIR="$MIRROR" node "$REPO/src/install-hooks.js" --merge --settings "$SETTINGS"
    echo "Merged cockpit hooks into: $SETTINGS"
  else
    CK_MIRROR_DIR="$MIRROR" node "$REPO/src/install-hooks.js" --print
  fi
fi

if [ "$NO_START" -eq 1 ]; then
  echo "Start skipped (--no-start)"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "WOULD start cockpit on port $PORT if not already listening, then verify /live"
elif [ -n "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)" ]; then
  # A listener already holds the port. Distinguish OUR cockpit (a live /live route) from an unrelated
  # process squatting the port — telling a teammate "already running, fine" when it's some other
  # service would leave them with no cockpit and a misleading all-clear.
  if curl -sf "http://127.0.0.1:$PORT/live" >/dev/null 2>&1; then
    echo "Cockpit already running on port $PORT — use ./deploy.sh to update"
  else
    echo "ERROR: port $PORT is held by another process (no cockpit /live there)." >&2
    echo "       Free it, or set AGENT_DASHBOARD_PORT to an unused port. See docs/onboarding/INSTALL.md." >&2
    exit 1
  fi
else
  node "$MIRROR/start.js" || echo "WARN: start.js exited non-zero; proceeding to verify" >&2
  i=0
  while [ "$i" -lt 50 ]; do
    if curl -sf "http://127.0.0.1:$PORT/live" >/dev/null 2>&1; then break; fi
    sleep 0.1
    i=$((i + 1))
  done
  if ! curl -sf "http://127.0.0.1:$PORT/live" >/dev/null 2>&1; then
    echo "ERROR: /live did not return HTTP 200; check port $PORT and $MIRROR/start.js logs" >&2
    exit 1
  fi
  echo "Cockpit is live on port $PORT"
fi

echo "Install complete."
echo "Next: personalize $MIRROR/config.json clientMap."
if [ "$MERGE_HOOKS" -eq 0 ]; then
  echo "Next: merge the generated hooks into $SETTINGS (or rerun with --merge-hooks)."
fi
echo "Read $REPO/docs/onboarding/INSTALL.md for setup and verification."
