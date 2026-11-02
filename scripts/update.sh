#!/bin/bash
#
# ip-cam-master self-update runner — 9-stage pipeline with two-stage rollback.
# Phase 24 (UPD-AUTO-04, UPD-AUTO-07).
#
# Spawned by `systemctl start --no-block ip-cam-master-updater.service`.
# Reads its environment from /run/ip-cam-master-update.env (written by
# spawnUpdateRun() in src/lib/server/services/update-runner.ts):
#   LOG, EXITCODE_FILE, PRE_SHA, PRE_SCHEMA_HASH, TARGET_SHA, UPDATE_TRIGGER
#
# Writes incremental progress to $LOG with `[stage=<name>]` markers the
# UI's UpdateStageStepper parses. Final exit code goes to $EXITCODE_FILE
# AND the .update-state/state.json file (atomic via Python3 tmp+rename
# so the Node side reading state.json never sees partial JSON).
#
# Exit codes:
#   0 = success
#   1 = failed before rollback (bad args, lock, preflight)
#   2 = failed but rolled back to PRE_SHA (stage1 or stage2)
#   3 = failed AND rollback failed (manual SSH intervention required)

set -o pipefail

PRE_SHA="${PRE_SHA:-${1:-}}"
PRE_SCHEMA_HASH="${PRE_SCHEMA_HASH:-${2:-}}"
TARGET_SHA="${TARGET_SHA:-}"
UPDATE_TRIGGER="${UPDATE_TRIGGER:-manual}"
LOG="${LOG:-/tmp/ip-cam-master-update-$(date +%s).log}"
EXITCODE_FILE="${EXITCODE_FILE:-${LOG%.log}.exitcode}"
INSTALL_DIR="${INSTALL_DIR:-/opt/ip-cam-master}"
LOCK_FILE="/run/ip-cam-master-deploy.lock"
STATE_DIR="$INSTALL_DIR/.update-state"
STATE_FILE="$STATE_DIR/state.json"
SNAPSHOT_DIR="$STATE_DIR/snapshots"
SNAPSHOT_KEEP=3
SERVICE_NAME="ip-cam-master"
HEALTH_URL="http://127.0.0.1/api/version"
DRAIN_URL="http://127.0.0.1/api/internal/prepare-for-shutdown"
HEALTH_TIMEOUT=60
DRAIN_TIMEOUT=30

# --- Helpers -----------------------------------------------------------

touch "$LOG"

log() {
	local ts
	ts="$(date '+%H:%M:%S')"
	echo "[$ts] $*" | tee -a "$LOG"
}

stage() {
	echo "[stage=$1]" | tee -a "$LOG"
	log "→ stage: $1"
}

write_exit() {
	echo "$1" > "$EXITCODE_FILE"
}

# Atomic state.json mutation via Python3 (tmp + os.replace).
# Args: <key>=<value> ...
# Values are JSON-serialised: bare numbers/booleans pass through,
# strings get JSON-quoted. `null` is a literal null. `auto:<expr>`
# evaluates a python expression (used for time.time() etc).
state_patch() {
	if ! command -v python3 >/dev/null 2>&1; then
		log "WARNING: python3 not present, state.json not patched"
		return 0
	fi
	mkdir -p "$STATE_DIR"
	python3 - "$STATE_FILE" "$@" <<'PYEOF'
import json, os, sys, time
path = sys.argv[1]
patch = {}
for arg in sys.argv[2:]:
	if '=' not in arg:
		continue
	key, raw = arg.split('=', 1)
	if raw == 'null':
		patch[key] = None
	elif raw in ('true', 'false'):
		patch[key] = (raw == 'true')
	elif raw.startswith('json:'):
		patch[key] = json.loads(raw[5:])
	elif raw.startswith('time:'):
		patch[key] = time.time()
	else:
		patch[key] = raw
state = {}
try:
	with open(path) as f:
		state = json.load(f)
except Exception:
	state = {}
state.update(patch)
tmp = path + ".tmp"
with open(tmp, 'w') as f:
	json.dump(state, f, indent=2)
os.replace(tmp, path)
PYEOF
}

# --- Lock acquisition --------------------------------------------------

exec 9>"$LOCK_FILE" || {
	log "ERROR: cannot open lock file $LOCK_FILE"
	echo "=== UPDATE_RESULT: failed (lock open failed, nothing changed) ===" | tee -a "$LOG"
	write_exit 1
	exit 1
}
if ! flock -n 9; then
	log "ERROR: another deploy/update is already running (lock held on $LOCK_FILE)"
	echo "=== UPDATE_RESULT: failed (deploy lock busy, nothing changed) ===" | tee -a "$LOG"
	write_exit 1
	exit 1
fi

# --- Pre-flight stage --------------------------------------------------

stage preflight

if [ -z "$PRE_SHA" ] || [ -z "$PRE_SCHEMA_HASH" ]; then
	log "ERROR: missing PRE_SHA or PRE_SCHEMA_HASH"
	echo "=== UPDATE_RESULT: failed (bad args, nothing changed) ===" | tee -a "$LOG"
	write_exit 1
	exit 1
fi

if [ ! -d "$INSTALL_DIR/.git" ]; then
	log "ERROR: $INSTALL_DIR is not a git working tree"
	echo "=== UPDATE_RESULT: failed (not a git tree) ===" | tee -a "$LOG"
	write_exit 1
	exit 1
fi

cd "$INSTALL_DIR" || {
	log "ERROR: cannot cd to $INSTALL_DIR"
	echo "=== UPDATE_RESULT: failed (cd failed) ===" | tee -a "$LOG"
	write_exit 1
	exit 1
}

# Disk space — require ≥500 MB free in install dir
free_kb="$(df --output=avail -k . 2>/dev/null | tail -n1 | tr -d ' ')"
if [ -n "$free_kb" ] && [ "$free_kb" -lt 512000 ]; then
	log "ERROR: insufficient disk space: ${free_kb} KB free, need ≥500 MB"
	echo "=== UPDATE_RESULT: failed (disk full) ===" | tee -a "$LOG"
	write_exit 1
	exit 1
fi

# Node version — require ≥22
if ! command -v node >/dev/null 2>&1; then
	log "ERROR: node not found in PATH"
	write_exit 1
	exit 1
fi
node_major="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$node_major" -lt 22 ]; then
	log "ERROR: node ${node_major} < 22"
	write_exit 1
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	log "ERROR: npm not found in PATH"
	write_exit 1
	exit 1
fi

# Working tree must be clean
if ! git diff-index --quiet HEAD --; then
	log "ERROR: working tree dirty — aborting"
	echo "=== UPDATE_RESULT: failed (dirty tree) ===" | tee -a "$LOG"
	write_exit 1
	exit 1
fi

state_patch "stage=preflight" "updateStartedAt=time:" "rollbackHappened=false"

log "Pre-flight ok. From=$PRE_SHA target=${TARGET_SHA:-<latest origin/main>} trigger=$UPDATE_TRIGGER"

# --- Snapshot stage ----------------------------------------------------

stage snapshot
mkdir -p "$SNAPSHOT_DIR"
SNAPSHOT_FILE="$SNAPSHOT_DIR/${PRE_SHA}.tar.gz"
if [ ! -f "$SNAPSHOT_FILE" ]; then
	log "Creating snapshot: $SNAPSHOT_FILE"
	tar -czf "$SNAPSHOT_FILE" \
		--exclude='node_modules' \
		--exclude='.svelte-kit' \
		--exclude='build' \
		--exclude='.update-state' \
		--exclude='data' \
		-C "$INSTALL_DIR" . 2>>"$LOG" || {
		log "WARNING: snapshot tar failed (non-fatal — proceeding without rollback stage 2)"
		rm -f "$SNAPSHOT_FILE"
	}
else
	log "Snapshot already exists for $PRE_SHA"
fi
# Retain only last $SNAPSHOT_KEEP snapshots (oldest first by mtime)
ls -t "$SNAPSHOT_DIR"/*.tar.gz 2>/dev/null | tail -n +$((SNAPSHOT_KEEP + 1)) | xargs -r rm -f
state_patch "stage=snapshot"

# --- Drain stage -------------------------------------------------------

stage drain
log "Draining live connections + WAL checkpoint via $DRAIN_URL"
if curl -fs --max-time "$DRAIN_TIMEOUT" -X POST -H "Host: 127.0.0.1" "$DRAIN_URL" >>"$LOG" 2>&1; then
	log "Drain ok"
else
	log "WARNING: drain endpoint returned non-200 (proceeding)"
fi
state_patch "stage=drain"

# --- Rollback function -------------------------------------------------

rollback() {
	local reason="$1"
	log "ROLLBACK reason: $reason"

	# --- Stage 1: git reset + reinstall + restart -----------------
	log "Rollback stage 1: git reset --hard $PRE_SHA"
	state_patch "rollbackHappened=true" "rollbackReason=$reason" "rollbackStage=stage1"

	if git reset --hard "$PRE_SHA" 2>&1 | tee -a "$LOG"; then
		log "Stage 1: npm ci"
		if npm ci 2>&1 | tee -a "$LOG"; then
			log "Stage 1: npm run build"
			if npm run build 2>&1 | tee -a "$LOG"; then
				log "Stage 1: starting service"
				if systemctl start "$SERVICE_NAME" 2>&1 | tee -a "$LOG"; then
					log "Stage 1: verifying"
					if verify_health "$PRE_SHA"; then
						log "Stage 1 rollback succeeded"
						echo "=== UPDATE_RESULT: failed ($reason, rolled back stage1) ===" | tee -a "$LOG"
						state_patch "updateStatus=rolled_back" "rollbackStage=stage1"
						write_exit 2
						exit 0
					fi
				fi
			fi
		fi
	fi

	# --- Stage 2: tar restore from snapshot -----------------------
	log "Rollback stage 1 failed — escalating to stage 2 (tar restore)"
	state_patch "rollbackStage=stage2"

	if [ -f "$SNAPSHOT_FILE" ]; then
		log "Stage 2: extracting $SNAPSHOT_FILE"
		# Stop service first to release file locks
		systemctl stop "$SERVICE_NAME" 2>&1 | tee -a "$LOG" || true
		if tar -xzf "$SNAPSHOT_FILE" -C "$INSTALL_DIR" 2>&1 | tee -a "$LOG"; then
			# Reinstall deps post-extraction (snapshot excludes node_modules)
			npm ci 2>&1 | tee -a "$LOG" || log "WARNING: stage 2 npm ci failed"
			log "Stage 2: starting service"
			if systemctl start "$SERVICE_NAME" 2>&1 | tee -a "$LOG"; then
				if verify_health "$PRE_SHA"; then
					log "Stage 2 rollback succeeded"
					echo "=== UPDATE_RESULT: failed ($reason, rolled back stage2) ===" | tee -a "$LOG"
					state_patch "updateStatus=rolled_back" "rollbackStage=stage2"
					write_exit 2
					exit 0
				fi
			fi
		fi
	else
		log "ERROR: no snapshot file available for stage 2"
	fi

	log "BOTH ROLLBACK STAGES FAILED — manual intervention required"
	echo "=== UPDATE_RESULT: failed ($reason, rollback failed) ===" | tee -a "$LOG"
	state_patch "updateStatus=failed"
	write_exit 3
	exit 0
}

# verify_health <expected_sha> — returns 0 if /api/version reports
# matching SHA AND dbHealthy=true within $HEALTH_TIMEOUT seconds.
verify_health() {
	local expected="$1"
	local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		local body
		body="$(curl -fs --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
		if [ -n "$body" ]; then
			# Parse with python (json) — avoids bash JSON pain.
			local check
			check="$(python3 -c "
import json, sys
try:
	d = json.loads(sys.stdin.read())
	if d.get('sha') == '$expected' and d.get('dbHealthy') is True:
		print('ok')
	else:
		print('mismatch sha=', d.get('sha'), 'db=', d.get('dbHealthy'))
except Exception as e:
	print('parse-error', e)
" <<<"$body" 2>>"$LOG")"
			if [ "$check" = "ok" ]; then
				return 0
			fi
		fi
		sleep 2
	done
	log "verify timed out after ${HEALTH_TIMEOUT}s"
	return 1
}

# --- Stop stage --------------------------------------------------------

stage stop
log "Stopping $SERVICE_NAME"
if ! systemctl stop "$SERVICE_NAME" 2>&1 | tee -a "$LOG"; then
	log "WARNING: stop returned non-zero (continuing — service may already be stopped)"
fi
state_patch "stage=stop"

# --- Fetch stage -------------------------------------------------------

stage fetch
if ! git fetch origin main 2>&1 | tee -a "$LOG"; then
	rollback "fetch failed"
fi
state_patch "stage=fetch"

# --- Install stage -----------------------------------------------------

stage install
PRE_LOCKFILE_HASH="$(sha256sum package-lock.json 2>/dev/null | awk '{print $1}')"
PRE_PACKAGE_HASH="$(sha256sum package.json 2>/dev/null | awk '{print $1}')"

if ! git reset --hard origin/main 2>&1 | tee -a "$LOG"; then
	rollback "git reset failed"
fi
NEW_SHA="$(git rev-parse HEAD)"
log "Worktree at $NEW_SHA"

POST_LOCKFILE_HASH="$(sha256sum package-lock.json 2>/dev/null | awk '{print $1}')"
POST_PACKAGE_HASH="$(sha256sum package.json 2>/dev/null | awk '{print $1}')"

if [ "$PRE_LOCKFILE_HASH" != "$POST_LOCKFILE_HASH" ] || [ "$PRE_PACKAGE_HASH" != "$POST_PACKAGE_HASH" ]; then
	log "Dependencies changed — running npm ci"
	if ! npm ci 2>&1 | tee -a "$LOG"; then
		rollback "npm ci failed"
	fi
else
	log "Dependencies unchanged — skipping npm ci"
fi

# Schema-hash compare (non-blocking)
if [ -f "src/lib/server/db/schema.ts" ]; then
	POST_SCHEMA_HASH="$(sha256sum src/lib/server/db/schema.ts | awk '{print $1}')"
	if [ "$POST_SCHEMA_HASH" != "$PRE_SCHEMA_HASH" ]; then
		log "schema.ts changed — db/client.ts CREATE TABLE IF NOT EXISTS handles new tables; verify post-restart"
	fi
fi
state_patch "stage=install"

# --- Build stage -------------------------------------------------------

stage build
rm -rf .svelte-kit build
if ! npm run build 2>&1 | tee -a "$LOG"; then
	rollback "build failed"
fi
state_patch "stage=build"

# --- Start stage -------------------------------------------------------

stage start
if ! systemctl start "$SERVICE_NAME" 2>&1 | tee -a "$LOG"; then
	rollback "service start failed"
fi
state_patch "stage=start"

# --- Verify stage ------------------------------------------------------

stage verify
log "Polling $HEALTH_URL — expecting sha=$NEW_SHA AND dbHealthy=true (timeout ${HEALTH_TIMEOUT}s)"
if ! verify_health "$NEW_SHA"; then
	rollback "verify timeout — service unhealthy after restart"
fi

# --- Success -----------------------------------------------------------

log "Update complete: $PRE_SHA -> $NEW_SHA"
state_patch \
	"updateStatus=idle" \
	"currentSha=$NEW_SHA" \
	"rollbackSha=$PRE_SHA" \
	"rollbackHappened=false" \
	"rollbackReason=null" \
	"rollbackStage=null" \
	"targetSha=null" \
	"stage=verify"
echo "=== UPDATE_RESULT: success ($PRE_SHA -> $NEW_SHA) ===" | tee -a "$LOG"
write_exit 0
exit 0
