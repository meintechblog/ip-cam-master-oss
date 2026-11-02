#!/bin/bash
#
# ip-cam-master dev-deploy (Mac → VM)
#
# Replaces the old rsync-based workflow. Pushes the local git HEAD
# directly to /opt/ip-cam-master on the VM, where a post-receive
# hook handles npm ci, build, and service restart.
#
# Requirements:
#   - SSH alias `ip-cam-master` configured in ~/.ssh/config (or set
#     IP_CAM_MASTER_HOST env var to a reachable host)
#   - Mac's public key installed in /root/.ssh/authorized_keys on the VM
#   - VM was migrated once via scripts/migrate-install.sh
#
# Usage:
#   ./scripts/dev-deploy.sh           # push current HEAD
#   ./scripts/dev-deploy.sh --force   # allow non-fast-forward push

set -euo pipefail

REMOTE_NAME="vm"
REMOTE_HOST="${IP_CAM_MASTER_HOST:-ip-cam-master}"
REMOTE_PATH="/opt/ip-cam-master"
REMOTE_URL="$REMOTE_HOST:$REMOTE_PATH"
BRANCH="main"

FORCE_PUSH=0
for arg in "$@"; do
	case "$arg" in
		--force) FORCE_PUSH=1 ;;
		*) echo "unknown arg: $arg" >&2; exit 2 ;;
	esac
done

log() {
	echo "[dev-deploy] $*"
}

fail() {
	echo "[dev-deploy] ERROR: $*" >&2
	exit 1
}

cd "$(git rev-parse --show-toplevel)" || fail "not in a git repo"

# --- 1. verify clean working tree ------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
	log "Working tree is dirty:"
	git status --short
	fail "commit or stash your changes first. Dev-deploy pushes committed state only."
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$BRANCH" ]; then
	fail "on branch '$current_branch', expected '$BRANCH'. Switch branches or update this script."
fi

# --- 2. ensure git remote exists -------------------------------------------

if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
	log "Adding git remote '$REMOTE_NAME' → $REMOTE_URL"
	git remote add "$REMOTE_NAME" "$REMOTE_URL"
else
	existing_url="$(git remote get-url "$REMOTE_NAME")"
	if [ "$existing_url" != "$REMOTE_URL" ]; then
		log "Updating remote '$REMOTE_NAME' URL: $existing_url → $REMOTE_URL"
		git remote set-url "$REMOTE_NAME" "$REMOTE_URL"
	fi
fi

# --- 3. ping VM -------------------------------------------------------------

log "Verifying SSH to $REMOTE_HOST..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" "test -d $REMOTE_PATH/.git" 2>/dev/null; then
	fail "cannot reach $REMOTE_HOST or $REMOTE_PATH/.git missing. Run scripts/migrate-install.sh on the VM first."
fi

# --- 4. push ----------------------------------------------------------------

LOCAL_SHA="$(git rev-parse --short HEAD)"
log "Pushing $LOCAL_SHA to $REMOTE_NAME/$BRANCH..."

if [ "$FORCE_PUSH" -eq 1 ]; then
	git push --force "$REMOTE_NAME" "HEAD:$BRANCH"
else
	git push "$REMOTE_NAME" "HEAD:$BRANCH"
fi

log "Done. Post-receive hook on VM ran npm ci / build / restart inline (see output above)."
