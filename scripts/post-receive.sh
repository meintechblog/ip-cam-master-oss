#!/bin/bash
#
# ip-cam-master post-receive hook
#
# Runs on the VM after `git push` updates /opt/ip-cam-master.
# With `receive.denyCurrentBranch = updateInstead`, git has already
# advanced HEAD and the working tree. This hook handles the rest:
# acquire deploy lock, install deps, build, restart service.
#
# Installed to .git/hooks/post-receive by scripts/migrate-install.sh.
# Coordinated with scripts/update.sh via /run/ip-cam-master-deploy.lock.

set -o pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/ip-cam-master}"
LOCK_FILE="/run/ip-cam-master-deploy.lock"
SERVICE_NAME="ip-cam-master"

log() {
	echo "[post-receive] $*"
}

fail() {
	log "ERROR: $*"
	exit 1
}

only_main_was_updated=0
while read -r _oldrev newrev refname; do
	if [ "$refname" = "refs/heads/main" ]; then
		only_main_was_updated=1
		POST_SHA="$newrev"
	else
		log "Ignoring push to $refname (only main triggers rebuild)"
	fi
done

if [ "$only_main_was_updated" -ne 1 ]; then
	exit 0
fi

log "main updated to ${POST_SHA:0:7} — acquiring deploy lock"

exec 9>"$LOCK_FILE" || fail "cannot open lock file $LOCK_FILE"
if ! flock -n 9; then
	fail "another deploy/update is running (lock held on $LOCK_FILE). Push landed but build skipped — re-run scripts/migrate-install.sh after it finishes."
fi

cd "$INSTALL_DIR" || fail "cannot cd to $INSTALL_DIR"

log "Running npm ci..."
if ! npm ci 2>&1; then
	fail "npm ci failed — service NOT restarted, worktree at ${POST_SHA:0:7}"
fi

log "Running npm run build..."
if ! npm run build 2>&1; then
	fail "build failed — service NOT restarted, worktree at ${POST_SHA:0:7}"
fi

log "Restarting $SERVICE_NAME..."
if ! systemctl restart "$SERVICE_NAME" 2>&1; then
	fail "systemctl restart failed"
fi

sleep 2
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
	fail "service not active after restart — check journalctl -u $SERVICE_NAME"
fi

log "Deploy complete: ${POST_SHA:0:7} live"
