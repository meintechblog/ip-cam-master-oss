#!/bin/bash
#
# Install or refresh /etc/systemd/system/ip-cam-master-updater.service
# from the running install dir's scripts/update/ip-cam-master-updater.service.
#
# Idempotent. Best-effort. Can be re-run safely.
#
# Used by:
#   - install.sh on first VM provision
#   - scripts/post-receive.sh on git-push deploy
#   - The Node app at boot via ensureUpdaterUnitInstalled() (in
#     update-runner.ts) — this script is the bash equivalent.

set -o pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/ip-cam-master}"
UNIT_NAME="ip-cam-master-updater.service"
SOURCE="$INSTALL_DIR/scripts/update/$UNIT_NAME"
TARGET="/etc/systemd/system/$UNIT_NAME"

if [ ! -f "$SOURCE" ]; then
	echo "[install-updater-unit] source not found: $SOURCE" >&2
	exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
	echo "[install-updater-unit] not root, skipping (must be run as root)" >&2
	exit 0
fi

# Only copy if source is newer than target (mtime compare).
if [ -f "$TARGET" ]; then
	src_mtime="$(stat -c '%Y' "$SOURCE" 2>/dev/null || echo 0)"
	tgt_mtime="$(stat -c '%Y' "$TARGET" 2>/dev/null || echo 0)"
	if [ "$src_mtime" -le "$tgt_mtime" ]; then
		echo "[install-updater-unit] target is up-to-date, no-op"
		exit 0
	fi
fi

cp "$SOURCE" "$TARGET"
chmod 0644 "$TARGET"
echo "[install-updater-unit] installed $TARGET"

systemctl daemon-reload || echo "[install-updater-unit] daemon-reload failed (non-fatal)"
systemctl enable "$UNIT_NAME" 2>/dev/null || true

echo "[install-updater-unit] done"
