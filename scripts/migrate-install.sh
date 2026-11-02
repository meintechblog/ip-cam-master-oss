#!/bin/bash
#
# ip-cam-master install migration
#
# Idempotent migration that brings an existing VM install to the
# git-push-deploy model:
#   1. Clean any rsync-induced dirty state on /opt/ip-cam-master/.git
#   2. Enable `receive.denyCurrentBranch = updateInstead` so direct
#      pushes from the developer's Mac update the working tree
#   3. Install .git/hooks/post-receive so those pushes trigger
#      npm ci / build / systemctl restart
#   4. Run a full ci/build/restart cycle to reach a clean baseline
#
# Safe to re-run at any time — skips steps already applied.
#
# Coordinated with scripts/update.sh via /run/ip-cam-master-deploy.lock.

set -o pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/ip-cam-master}"
LOCK_FILE="/run/ip-cam-master-deploy.lock"
SERVICE_NAME="ip-cam-master"

log() {
	echo "[migrate-install] $*"
}

fail() {
	log "ERROR: $*"
	exit 1
}

if [ "$(id -u)" -ne 0 ]; then
	fail "must run as root"
fi

[ -d "$INSTALL_DIR/.git" ] || fail "$INSTALL_DIR is not a git working tree"
cd "$INSTALL_DIR" || fail "cannot cd to $INSTALL_DIR"

log "Acquiring deploy lock..."
exec 9>"$LOCK_FILE" || fail "cannot open lock file $LOCK_FILE"
if ! flock -n 9; then
	fail "another deploy/update is running (lock held). Wait and re-run."
fi

# --- 1. clean up dirty state ------------------------------------------------

log "Fetching origin..."
git fetch origin 2>&1 || log "WARN: git fetch failed — continuing with local state"

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main 2>/dev/null || echo '')"
IS_DIRTY=0
if [ -n "$(git status --porcelain)" ]; then IS_DIRTY=1; fi

if [ "$IS_DIRTY" -eq 1 ]; then
	# Dirty tree (typical recovery case from rsync-era). Snap to the
	# latest known-good state: origin/main if available, else HEAD.
	if [ -n "$REMOTE_SHA" ]; then
		log "Worktree dirty — resetting to origin/main ($REMOTE_SHA) and cleaning..."
		git reset --hard "$REMOTE_SHA" 2>&1 || fail "git reset failed"
	else
		log "Worktree dirty and origin unreachable — resetting to HEAD ($LOCAL_SHA) and cleaning..."
		git reset --hard HEAD 2>&1 || fail "git reset failed"
	fi
	git clean -fd 2>&1 || fail "git clean failed"
elif [ -n "$REMOTE_SHA" ] && [ "$LOCAL_SHA" != "$REMOTE_SHA" ] && git merge-base --is-ancestor "$LOCAL_SHA" "$REMOTE_SHA" 2>/dev/null; then
	# Clean worktree but strictly behind origin/main — fast-forward.
	log "Worktree clean but behind origin/main — fast-forwarding to $REMOTE_SHA..."
	git reset --hard "$REMOTE_SHA" 2>&1 || fail "git reset failed"
else
	# Clean worktree at or ahead of origin (dev-deploy push lands here).
	log "Worktree clean at $LOCAL_SHA — no reset needed"
fi

# --- 2. enable direct-push acceptance ---------------------------------------

current_denypolicy="$(git config --local --get receive.denyCurrentBranch 2>/dev/null || echo 'unset')"
if [ "$current_denypolicy" != "updateInstead" ]; then
	log "Setting receive.denyCurrentBranch = updateInstead..."
	git config --local receive.denyCurrentBranch updateInstead
else
	log "receive.denyCurrentBranch already set to updateInstead"
fi

# Historical rsync runs have copied the Mac developer's .git/config onto the
# VM, leaving a core.hooksPath pointing at a non-existent /Users/... path.
# Git silently skips hook execution in that case. Clear any such stale value
# so the default .git/hooks/post-receive is used.
stale_hookspath="$(git config --local --get core.hooksPath 2>/dev/null || true)"
if [ -n "$stale_hookspath" ] && [ ! -d "$stale_hookspath" ]; then
	log "Clearing stale core.hooksPath ($stale_hookspath)..."
	git config --local --unset core.hooksPath
fi

# --- 3. install post-receive hook ------------------------------------------

HOOK_SRC="$INSTALL_DIR/scripts/post-receive.sh"
HOOK_DEST="$INSTALL_DIR/.git/hooks/post-receive"

[ -f "$HOOK_SRC" ] || fail "missing $HOOK_SRC (incomplete checkout?)"

if ! cmp -s "$HOOK_SRC" "$HOOK_DEST" 2>/dev/null; then
	log "Installing post-receive hook..."
	cp "$HOOK_SRC" "$HOOK_DEST"
	chmod +x "$HOOK_DEST"
else
	log "post-receive hook already up to date"
fi

# --- 4. ci + build + restart ------------------------------------------------

log "Running npm ci..."
npm ci 2>&1 || fail "npm ci failed"

log "Running npm run build..."
npm run build 2>&1 || fail "build failed"

log "Restarting $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME" 2>&1 || fail "restart failed"

sleep 2
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
	fail "service not active after restart — check journalctl -u $SERVICE_NAME"
fi

POST_SHA="$(git rev-parse --short HEAD)"
log "Migration complete. VM is on $POST_SHA, ready for dev-deploy pushes."
