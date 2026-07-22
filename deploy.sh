#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${CK_REPO:-$SCRIPT_DIR}"
MIRROR="${CK_MIRROR_DIR:-$HOME/.claude/agent-dashboard}"
PORT="${AGENT_DASHBOARD_PORT:-3847}"
PIDFILE="server.pid"
if [ -n "${AGENT_DASHBOARD_PORT:-}" ]; then
  PIDFILE="server-$PORT.pid"
fi

DRY_RUN=0
SKIP_TESTS=0
NO_RESTART=0

usage() {
  cat <<EOF
Usage: ./deploy.sh [--dry-run|-n] [--skip-tests] [--no-restart] [-h|--help]

Sync whitelisted Falaq Cockpit sources to the agent dashboard mirror and restart it.

Environment:
  AGENT_DASHBOARD_PORT  Port to restart (default: 3847)
  CK_MIRROR_DIR         Mirror directory (default: \$HOME/.claude/agent-dashboard)
  CK_REPO               Source repo directory (default: this script's directory)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Keep deploy and first-time install in lockstep from one reviewed source list.
if [ ! -s "$REPO/files.whitelist" ]; then
  echo "Missing or empty $REPO/files.whitelist — refusing to deploy an empty file set" >&2
  exit 1
fi
WHITELIST="$(cat "$REPO/files.whitelist")"

listener_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

mirror_server_pids() {
  pgrep -f "$MIRROR/server.js" 2>/dev/null || true
}

print_config_drift() {
  if [ -f "$REPO/src/config.json" ] && [ -f "$MIRROR/config.json" ]; then
    if ! diff -q "$REPO/src/config.json" "$MIRROR/config.json" >/dev/null 2>&1; then
      echo "WARN: config.json differs between source and mirror; preserving mirror/config.json"
    fi
  fi
}

wait_port_empty() {
  i=0
  while [ "$i" -lt 50 ]; do
    if [ -z "$(listener_pids)" ]; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

wait_live() {
  i=0
  while [ "$i" -lt 100 ]; do
    if curl -sf "http://127.0.0.1:$PORT/live" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

echo "Falaq Cockpit deploy"
echo "  repo:   $REPO"
echo "  mirror: $MIRROR"
echo "  port:   $PORT"

if [ ! -d "$REPO/src" ]; then
  echo "Missing source directory: $REPO/src" >&2
  exit 1
fi
if [ ! -d "$MIRROR" ]; then
  echo "Missing mirror directory: $MIRROR" >&2
  exit 1
fi

if [ "$SKIP_TESTS" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "Running tests..."
  "$REPO/run-tests.sh"
elif [ "$SKIP_TESTS" -eq 1 ]; then
  echo "Skipping tests (--skip-tests)"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "Skipping tests for dry run"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  LISTENER="$(listener_pids | tr '\n' ' ')"
  if [ -n "$LISTENER" ]; then
    echo "Current listener pid(s): $LISTENER"
  else
    echo "Current listener pid(s): none"
  fi
  echo "Planned source sync:"
  for f in $WHITELIST; do
    if [ ! -f "$REPO/src/$f" ]; then
      echo "  MISSING source: $f"
    elif [ ! -f "$MIRROR/$f" ]; then
      echo "  WOULD ADD: $f"
    elif diff -q "$REPO/src/$f" "$MIRROR/$f" >/dev/null 2>&1; then
      echo "  unchanged: $f"
    else
      echo "  WOULD UPDATE: $f"
    fi
  done
  print_config_drift
  if [ "$NO_RESTART" -eq 1 ]; then
    echo "Planned restart: none (--no-restart)"
  else
    echo "Planned restart: SIGTERM current listener/server processes, then node \"$MIRROR/start.js\""
  fi
  exit 0
fi

BACKUP="$MIRROR/.deploy-backup-$(date +%s)"
mkdir -p "$BACKUP"
for f in $WHITELIST; do
  if [ -f "$MIRROR/$f" ]; then
    mkdir -p "$BACKUP/$(dirname "$f")"
    cp -p "$MIRROR/$f" "$BACKUP/$f"
  fi
done
echo "Backup: $BACKUP"

print_config_drift

echo "Syncing whitelisted source files..."
for f in $WHITELIST; do
  if [ ! -f "$REPO/src/$f" ]; then
    echo "Missing source file: $REPO/src/$f" >&2
    exit 1
  fi
  mkdir -p "$MIRROR/$(dirname "$f")"
  # Atomic per-file: copy to a temp then mv (same fs) so an interrupted/failed copy
  # can never leave a truncated code file on the mirror to break a later restart.
  cp -p "$REPO/src/$f" "$MIRROR/$f.deploy-tmp"
  mv "$MIRROR/$f.deploy-tmp" "$MIRROR/$f"
done

# Stamp the repo location so runtime code (the nondev-profile __COCKPIT__ deny floors) can find the
# real source checkout on any machine — teammates may clone anywhere, and env vars don't reach the
# long-lived server.
# Record the MAIN clone, not whichever worktree happens to deploy — the auto-updater pulls this
# path, and worktrees get removed after merge (which would silently disable updates).
MAIN_ROOT="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null)"
[ -n "$MAIN_ROOT" ] && [ -d "$MAIN_ROOT/.git" ] || MAIN_ROOT="$REPO"
printf '%s' "$MAIN_ROOT" > "$MIRROR/.repo-root.deploy-tmp"
mv "$MIRROR/.repo-root.deploy-tmp" "$MIRROR/.repo-root"

echo "Verifying sync..."
for f in $WHITELIST; do
  SRC_SUM="$(shasum "$REPO/src/$f" | awk '{print $1}')"
  MIRROR_SUM="$(shasum "$MIRROR/$f" | awk '{print $1}')"
  if [ "$SRC_SUM" != "$MIRROR_SUM" ]; then
    echo "Checksum mismatch after sync: $f" >&2
    exit 1
  fi
done

if [ "$NO_RESTART" -eq 1 ]; then
  echo "Synced, not restarted (--no-restart)"
  exit 0
fi

echo "Restarting cockpit server..."
SIGNALED=""
LISTENER="$(listener_pids || true)"
for pid in $LISTENER; do
  echo "SIGTERM listener pid $pid"
  kill "$pid" 2>/dev/null || true
  SIGNALED="$SIGNALED $pid"
done

OTHERS="$(mirror_server_pids || true)"
for pid in $OTHERS; do
  ALREADY=0
  for seen in $SIGNALED; do
    if [ "$pid" = "$seen" ]; then ALREADY=1; fi
  done
  if [ "$ALREADY" -eq 0 ]; then
    echo "SIGTERM mirror server pid $pid"
    kill "$pid" 2>/dev/null || true
  fi
done

if ! wait_port_empty; then
  echo "Port $PORT did not clear after SIGTERM" >&2
  exit 1
fi

# Guarded: never let a non-zero start.js abort before verify — otherwise set -e would
# exit here with the old listener already SIGTERM'd and no ❌/restore hint printed.
node "$MIRROR/start.js" || echo "WARN: start.js exited non-zero; proceeding to verify" >&2

VERIFY_OK=1
if ! wait_live; then
  echo "Verify failed: /live did not return HTTP 200" >&2
  VERIFY_OK=0
fi

LISTENER_LINES="$(listener_pids || true)"
LISTENER_COUNT="$(printf "%s\n" "$LISTENER_LINES" | sed '/^$/d' | wc -l | tr -d ' ')"
LIVE_PID="$(printf "%s\n" "$LISTENER_LINES" | sed '/^$/d' | head -n 1)"
if [ "$LISTENER_COUNT" != "1" ]; then
  echo "Verify failed: expected exactly one listener on :$PORT, found $LISTENER_COUNT" >&2
  VERIFY_OK=0
fi

if [ ! -f "$MIRROR/$PIDFILE" ]; then
  echo "Verify failed: missing pid file $MIRROR/$PIDFILE" >&2
  VERIFY_OK=0
else
  PIDFILE_PID="$(cat "$MIRROR/$PIDFILE")"
  if [ "$PIDFILE_PID" != "$LIVE_PID" ]; then
    echo "Verify failed: pid file $PIDFILE_PID != listener $LIVE_PID" >&2
    VERIFY_OK=0
  fi
fi

SERVER_PIDS="$(mirror_server_pids || true)"
EXTRA=""
for pid in $SERVER_PIDS; do
  if [ "$pid" != "$LIVE_PID" ]; then
    EXTRA="$EXTRA $pid"
  fi
done
if [ -n "$EXTRA" ]; then
  echo "Verify failed: extra mirror server.js process(es):$EXTRA" >&2
  VERIFY_OK=0
fi

TRANSCRIPT_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/chats/x/transcript" 2>/dev/null || true)"
if [ "$TRANSCRIPT_CODE" = "404" ] || [ -z "$TRANSCRIPT_CODE" ]; then
  echo "Verify failed: transcript smoke returned ${TRANSCRIPT_CODE:-no response}" >&2
  VERIFY_OK=0
fi

if [ "$VERIFY_OK" -ne 1 ]; then
  echo "❌ Deploy verify failed. Backup is at: $BACKUP" >&2
  echo "Restore then restart manually with:" >&2
  echo "  cp -R \"$BACKUP/.\" \"$MIRROR/\"" >&2
  # Only carry the env var when a custom port was set; on a default deploy the bare
  # command keeps server.js writing server.pid (not server-3847.pid).
  if [ -n "${AGENT_DASHBOARD_PORT:-}" ]; then
    echo "  AGENT_DASHBOARD_PORT=\"$PORT\" node \"$MIRROR/start.js\"" >&2
  else
    echo "  node \"$MIRROR/start.js\"" >&2
  fi
  exit 1
fi

SERVER_SUM="$(shasum "$REPO/src/server.js" | awk '{print $1}')"
echo "✅ Deploy complete. live pid: $LIVE_PID, src/server.js shasum: $SERVER_SUM"
