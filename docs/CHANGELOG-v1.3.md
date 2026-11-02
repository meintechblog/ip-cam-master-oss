# v1.3 Changelog (in progress)

> v1.3 milestone is **Protect Stream Hub**. P19 + P20 ship the catalog and bridge; P21–P23 deliver outputs, wizard, and offboarding. P24 (this entry) is parallel-track maintenance shipped on the same git history.

## Phase 24 — Auto-Update Parity (2026-05-05)

Brings the in-app self-update feature to charging-master parity. Same trigger, same rollback safety, same UX polish.

**User-visible changes (Settings → Version):**
- New **Auto-Update** card with on/off toggle and a 0–23 hour dropdown (Europe/Berlin)
- New **9-stage pipeline stepper** during install (preflight → snapshot → drain → stop → fetch → install → build → start → verify), color-coded (pending / running / done / failed / rolled_back)
- New **install confirmation modal** showing current → target SHA + commit metadata + active-flow conflict warnings (refuses or gates on Hub bridge starting/stopping)
- New **reconnect overlay** during install — non-dismissable while service restarts, polls `/api/version` every 2s, auto-closes when new SHA reports `dbHealthy=true`
- **Pulsing green dot** on the "Update verfügbar" badge
- **History table** grows to 10 rows + new "Auslöser" column distinguishing `manuell` vs `auto`
- **Rollback banner** with stage-1 vs stage-2 indicator + dismiss button (calls `/api/update/ack-rollback`)

**Backend changes:**
- New `update_runs` SQLite table replaces the JSON blob in `settings.update_run_history` (auto-migrates legacy data on first read)
- Atomic `.update-state/state.json` shared between Node and bash via tmp+rename; carries SHA, ETag, rollback fields, in-progress markers
- Generated `src/lib/version.ts` at build time (`gen:version` prebuild step) — no more runtime `git describe` exec, removes the `.git`-must-exist-at-runtime dependency
- `github-client.ts` with ETag-cached commit polling — 304 Not Modified consumes 0 of the unauthenticated 60 req/h budget
- Background scheduler: 6h check tick + 5min auto-update opportunity tick, `tz=Europe/Berlin`, 23h minimum spacing, dedup'd skip-reason logging
- `/api/internal/prepare-for-shutdown` drain endpoint stops scheduler + WAL checkpoint before service stop
- Two-stage rollback in `update.sh`: Stage 1 git reset + reinstall, Stage 2 tarball restore from snapshot
- Dedicated `ip-cam-master-updater.service` systemd unit (Type=oneshot, sibling cgroup) replaces transient `systemd-run` — fixes the parent-cgroup-kill problem at the `stop` stage
- 5-min server-side cooldown on manual `POST /api/update/check`
- Localhost-only guards on `POST /api/update/run` and `POST /api/update/ack-rollback`

**New endpoints:**
- `GET /api/version` — `{ sha, shaShort, buildTime, dbHealthy, rollbackSha, updateStatus }` (used by the bash verify stage + reconnect overlay)
- `GET /api/update/run-preflight` — `{ current, target, hasUpdate, dirtyFiles, conflicts }` (drives the install modal)
- `POST /api/update/ack-rollback` — clears rollback banner + resets `updateStatus` to idle

**Files** (16 new, 14 modified, 6 test files updated): see `.planning/phases/24-auto-update-parity/24-SUMMARY.md`.

**Out of scope (deferred):**
- Pushover notifications on success/failure
- Update channel selection (always `origin/main`)
- Pre-update changelog rendering in the UI
- Authenticated GitHub API (the unauthenticated 60 req/h budget is plenty for 6h polling)

**Stats:** 27 atomic commits (24 planned + 3 polish during live UAT). 0 TypeScript errors, build clean, 56/56 P24-touched tests pass. Pre-existing onboarding/proxmox test failures (12) unchanged. Final SHA `ed2e36c` on local main + GitHub origin/main + VMID 104.
