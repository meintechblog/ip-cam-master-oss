/**
 * reconcile.ts — Protect Hub bridge reconciliation orchestrator.
 *
 * Heart of v1.3 Phase 21. Turns DB state (camera_outputs × cameras ×
 * protect_stream_catalog) into a deployed `go2rtc.yaml` on the bridge LXC,
 * with single-flight concurrency, canonical-hash dedupe, atomic tmp+rename
 * SSH push, and full audit trail in `protect_hub_reconcile_runs`.
 *
 * Architecture:
 *   See .planning/phases/21-multi-cam-yaml-reconciliation-loop/21-RESEARCH.md
 *       §"System Architecture Diagram" for the 4-pass picture.
 *   See .planning/phases/21-multi-cam-yaml-reconciliation-loop/21-PATTERNS.md
 *       §"reconcile.ts" for the canonical wiring spec.
 *
 * Flow per reconcile pass:
 *   - Pass 0: INSERT protect_hub_reconcile_runs row (status='running')
 *   - Pass 1: discover() — re-extracts Protect URLs (D-RCN-05, CR-5)
 *             + seedDefaultOutputsForNewCams (HUB-OUT-05 + HUB-RCN-08)
 *             + softDeleteMissingCams (HUB-RCN-09 + CR-6)
 *   - Pass 2: load OutputRow[] from DB (camera_outputs JOIN cameras JOIN catalog)
 *   - Pass 3: build YAML + canonical hash + mtime fast-path (Pattern 3)
 *   - Pass 4: atomic tmp+rename SSH push + systemctl restart (CR-1, CR-3)
 *
 * Concurrency: module-scoped single-flight Promise + dirty flag (Pattern 1,
 * P21-#6). isReconcilerBusy() is the synchronous external probe consumed by
 * update-checker.ts in Plan 06 (CR-4).
 *
 * Error handling: tagged-Result return (Pattern S-1). Throws are reserved for
 * programmer errors; expected failures (bridge_unreachable, error) fold to
 * `{ ok: false, status, error }` and update the audit row accordingly.
 */

import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, sqlite } from '$lib/server/db/client';
import {
	cameras,
	cameraOutputs,
	protectHubBridges,
	protectHubReconcileRuns,
	protectStreamCatalog,
	events
} from '$lib/server/db/schema';
import {
	connectToProxmox,
	executeOnContainer,
	pushFileToContainer
} from '$lib/server/services/ssh';
import { fetchBootstrap, normalizeMac } from '$lib/server/services/protect-bridge';
import { discover } from './catalog';
import {
	buildBridgeYaml,
	canonicalHash,
	type OutputRow,
	type OutputType
} from './yaml-builder';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

/** Why this reconcile pass was triggered. Used for audit/logging only. */
export type ReconcileReason = 'tick' | 'force' | 'output_toggle' | 'ws_reconnect';

/**
 * Tagged-Result return per Pattern S-1. Callers (API routes, scheduler tick,
 * ws-manager) match on `ok` to choose the response path; only programmer
 * errors throw. Expected failures (network down, SSH dial fail) fold to
 * `{ ok: false, status, error }` so the API layer can return JSON without
 * try/catch ceremony.
 */
export type ReconcileResult =
	| {
			ok: true;
			status: 'success';
			reconcileId: string;
			hashChanged: true;
			newHash: string;
			outputCount: number;
	  }
	| {
			ok: true;
			status: 'no_op';
			reconcileId: string;
			hashChanged: false;
			outputCount: number;
	  }
	| {
			ok: false;
			status: 'bridge_unreachable' | 'error';
			reconcileId: string;
			error: string;
	  };

// ────────────────────────────────────────────────────────────────────────────
// Module-scoped single-flight state (Pattern 1, P21-#6, L-13)
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-flight reconcile Promise. While non-null, all `reconcile()` callers join
 * this Promise instead of starting a new pass. Cleared in finally; if
 * `_dirty` was set during the in-flight pass, ONE follow-up is scheduled via
 * setImmediate (queue depth 1).
 */
let _inFlight: Promise<ReconcileResult> | null = null;
let _dirty = false;

/**
 * Synchronous external probe — true while a reconcile pass is in flight.
 *
 * Consumed by `update-checker.ts:getActiveFlowConflicts()` (Plan 06) to gate
 * the self-update flow with HTTP 409 + Retry-After: 60 (HUB-RCN-10 + L-14 +
 * D-API-04 + CR-4).
 */
export function isReconcilerBusy(): boolean {
	return _inFlight !== null;
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point — single-flight wrapper (Pattern 1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile the bridge LXC's go2rtc.yaml against the current DB state.
 *
 * Single-flight per-bridge: concurrent callers join the in-flight Promise
 * and set the dirty flag. After the in-flight pass resolves, if dirty was
 * set, ONE follow-up is scheduled via setImmediate.
 *
 * @param externalReconcileId  Plan 05: optional caller-supplied id used as
 *   the `protect_hub_reconcile_runs.reconcile_id` column AND echoed back
 *   in the result. Allows API callers (POST /api/protect-hub/reconcile) to
 *   pre-mint the id, return it to the client immediately (202), and have
 *   the client poll `GET /api/protect-hub/reconcile-runs?reconcileId=…`
 *   by the same id. When omitted, a fresh UUIDv4 is generated.
 *
 *   Single-flight nuance: if a reconcile is already in flight when a caller
 *   passes externalReconcileId, the new caller still joins the in-flight
 *   Promise — the in-flight reconcile keeps its own id. The externalReconcileId
 *   is IGNORED in that join case. Trade-off: API correlation is best-effort,
 *   single-flight correctness is absolute (per L-13). API clients that need
 *   guaranteed correlation should retry on the polled-row "not found" case
 *   (404 from GET /reconcile-runs) — the next reconcile pass will use their id.
 */
export async function reconcile(
	bridgeId: number,
	reason: ReconcileReason,
	externalReconcileId?: string
): Promise<ReconcileResult> {
	if (_inFlight) {
		// Concurrent caller: signal that another pass is needed and return
		// the in-flight Promise so the API/scheduler still gets a result.
		// The first caller's reconcileId is returned to all joiners — that's
		// fine because every audit row carries its own reconcileId, and the
		// caller-side reconcileId is for joining run-history queries only.
		// (externalReconcileId is intentionally dropped here — see fn doc.)
		_dirty = true;
		return _inFlight;
	}

	const reconcileId = externalReconcileId ?? randomUUID();
	const promise = doReconcile(bridgeId, reconcileId, reason);
	_inFlight = promise;

	try {
		return await promise;
	} finally {
		_inFlight = null;
		if (_dirty) {
			_dirty = false;
			// Queue depth 1 follow-up. Fire-and-forget; it will create its own
			// in-flight Promise via re-entry. setImmediate decouples it from
			// the original caller's resolved Promise so e.g. PUT /outputs
			// returns once the first reconcile finishes, not after the
			// follow-up.
			setImmediate(() => {
				reconcile(bridgeId, 'tick').catch(() => {
					/* swallow — error already audited in protect_hub_reconcile_runs */
				});
			});
		}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: doReconcile — the 4-pass orchestration body
// ────────────────────────────────────────────────────────────────────────────

const FINAL_YAML_PATH = '/etc/go2rtc/go2rtc.yaml';
const MTIME_TOLERANCE_SECONDS = 2; // ±2s clock skew between Proxmox host and app VM

async function doReconcile(
	bridgeId: number,
	reconcileId: string,
	_reason: ReconcileReason
): Promise<ReconcileResult> {
	// Pass 0: INSERT audit row BEFORE any side effects (T-21-05 mitigation).
	insertRunRow(reconcileId);

	const bridge = db
		.select()
		.from(protectHubBridges)
		.where(eq(protectHubBridges.id, bridgeId))
		.get();

	if (!bridge) {
		const err = `bridge id=${bridgeId} not found`;
		updateRunRow(reconcileId, { status: 'error', error: err });
		emitReconcileEvent(reconcileId, 'error', err, 0, null);
		return { ok: false, status: 'error', reconcileId, error: err };
	}

	try {
		// ── Pass 1a: discover() — re-extracts Protect URLs every pass (D-RCN-05, CR-5).
		// fetchBootstrap is also called below for the soft-delete diff; the
		// extra call is acceptable because the lib internally caches the
		// bootstrap with an 8-min refresh window (L-12). discover() reuses
		// the same cached client, so this is a one-roundtrip-per-reconcile cost.
		const discoverResult = await discover();
		if (!discoverResult.ok) {
			const errMsg = `discover() failed: ${discoverResult.reason} (${discoverResult.error.message})`;
			updateRunRow(reconcileId, { status: 'error', error: errMsg });
			emitReconcileEvent(reconcileId, 'error', errMsg, 0, null);
			return { ok: false, status: 'error', reconcileId, error: errMsg };
		}

		// ── Pass 1b: auto-add — seed default outputs for newly-discovered cams.
		// HUB-OUT-05 + HUB-RCN-08: first-party gets Loxone-MJPEG default ON,
		// third-party gets nothing (default OFF; user opts in via P22 UI).
		seedDefaultOutputsForNewCams();

		// ── Pass 1c: soft-delete — diff bootstrap MAC set against DB.
		// HUB-RCN-09 + CR-6 + L-20: cams missing from bootstrap → archived
		// (7-day grace before purge; UI surface is P23).
		// Decision (per plan task 6): call fetchBootstrap directly here for
		// the diff — avoids extending discover()'s return signature; lib's
		// 8-min refresh window absorbs the extra call cost.
		//
		// Sanity threshold (WR-01 mitigation, code-review 2026-05-06):
		// If bootstrap returns OK but the MAC set is suspiciously empty or
		// drastically smaller than what we have on file, refuse to archive
		// — the controller is likely mid-restart or returned a partial
		// response. A real cam removal would not wipe ALL cams in one tick;
		// the worst real case is a few cams gone at once. Threshold: only
		// archive if the bootstrap covers >= 50% of our currently-live
		// external cams.
		const bootstrap = await fetchBootstrap();
		if (bootstrap.ok) {
			const bootstrapMacs = new Set(
				bootstrap.cameras.map((c) => normalizeMac(c.mac ?? '')).filter((m) => m !== '')
			);
			const liveExternalCount = db
				.select({ n: sql<number>`count(*)` })
				.from(cameras)
				.where(eq(cameras.source, 'external'))
				.get()?.n ?? 0;
			const isSuspiciouslyEmpty =
				liveExternalCount > 0 &&
				bootstrapMacs.size < Math.ceil(liveExternalCount / 2);
			if (isSuspiciouslyEmpty) {
				emitReconcileEvent(
					reconcileId,
					'error',
					`bootstrap returned ${bootstrapMacs.size} cams vs ${liveExternalCount} on file — skipping soft-delete to avoid mass-archive`,
					0,
					null
				);
			} else {
				softDeleteMissingCams(bootstrapMacs);
			}
		}
		// If bootstrap fails here we silently skip soft-delete: discover() above
		// already succeeded, so this is a transient race; next tick retries.

		// ── Pass 2: build OutputRow[] from DB (the yaml-builder input).
		const rows = loadOutputRows();

		// ── Pass 3: build YAML + canonical hash + mtime fast-path.
		const yaml = buildBridgeYaml(rows, reconcileId);
		const newHash = canonicalHash(yaml);

		// SSH connect once — reused across mtime check (Pass 3) and push (Pass 4).
		// Pattern S-2 envelope: try/finally with dispose().
		let ssh: Awaited<ReturnType<typeof connectToProxmox>>;
		try {
			ssh = await connectToProxmox();
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			updateRunRow(reconcileId, { status: 'bridge_unreachable', error: e.message });
			emitReconcileEvent(reconcileId, 'error', `bridge unreachable: ${e.message}`, rows.length, null);
			return {
				ok: false,
				status: 'bridge_unreachable',
				reconcileId,
				error: e.message
			};
		}

		try {
			// Mtime fast-path: skip deploy when both hash and remote mtime match.
			// Skipped entirely on first deploy (lastDeployedYamlHash null).
			if (bridge.lastDeployedYamlHash !== null && bridge.lastDeployedYamlHash === newHash) {
				const noOpResult = await checkMtimeFastPath(
					ssh,
					bridge.vmid,
					bridge.lastReconciledAt
				);
				if (noOpResult.skip) {
					updateRunRow(reconcileId, {
						status: 'no_op',
						hashChanged: false,
						deployedYamlHash: newHash
					});
					emitReconcileEvent(
						reconcileId,
						'noop',
						`reconcile ${reconcileId} no-op (hash=${newHash.slice(0, 8)}, ${rows.length} streams)`,
						rows.length,
						newHash
					);
					return {
						ok: true,
						status: 'no_op',
						reconcileId,
						hashChanged: false,
						outputCount: rows.length
					};
				}
				// mtime drifted but hash matches → defensive re-deploy (P21-#11).
			}

			// ── Pass 4: atomic deploy.
			//
			// CR-1 mitigation (Option 2 — in-reconcile, not in ssh.ts):
			// pushFileToContainer is NOT atomic by default — it `pct push`es
			// directly to the final path. We push to a per-reconcileId tmp
			// path inside the LXC, then `mv` to the final path (atomic
			// rename on local FS). Mid-deploy SIGTERM leaves the existing
			// YAML intact (HUB-RCN-10 literally satisfied).
			//
			// CR-3: go2rtc has NO SIGHUP handler — `systemctl reload-or-restart`
			// would fall through to restart anyway. We use plain
			// `systemctl restart` to make the cost explicit. Every YAML
			// change costs ~1-3s consumer blip; canonical-hash dedupe (above)
			// skips 99% of reconciles.
			const tmpPath = `${FINAL_YAML_PATH}.tmp.${reconcileId}`;
			await pushFileToContainer(ssh, bridge.vmid, yaml, tmpPath);
			await executeOnContainer(ssh, bridge.vmid, `mv ${tmpPath} ${FINAL_YAML_PATH}`);
			await executeOnContainer(ssh, bridge.vmid, 'systemctl restart go2rtc');

			// Update bridge cache + audit row.
			const now = new Date().toISOString();
			db.update(protectHubBridges)
				.set({
					lastDeployedYamlHash: newHash,
					lastReconciledAt: now,
					updatedAt: now
				})
				.where(eq(protectHubBridges.id, bridge.id))
				.run();

			updateRunRow(reconcileId, {
				status: 'success',
				hashChanged: true,
				deployedYamlHash: newHash
			});
			emitReconcileEvent(
				reconcileId,
				'deployed',
				`reconcile ${reconcileId} deployed (hash=${newHash.slice(0, 8)}, ${rows.length} streams)`,
				rows.length,
				newHash
			);

			return {
				ok: true,
				status: 'success',
				reconcileId,
				hashChanged: true,
				newHash,
				outputCount: rows.length
			};
		} finally {
			ssh.dispose();
		}
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		// Distinguish bridge_unreachable from generic error by message shape.
		// SSH-layer errors that surface here (after the connect succeeded)
		// can include `pct push` / `pct exec` failures — those are still
		// effectively "bridge unreachable" from the orchestrator's POV.
		const isBridgeError = isLikelyBridgeError(e.message);
		const status: 'bridge_unreachable' | 'error' = isBridgeError
			? 'bridge_unreachable'
			: 'error';
		updateRunRow(reconcileId, { status, error: e.message });
		emitReconcileEvent(reconcileId, 'error', `reconcile failed: ${e.message}`, 0, null);
		return { ok: false, status, reconcileId, error: e.message };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: Pass 2 — DB query for OutputRow[]
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load the OutputRow[] that yaml-builder consumes.
 *
 * Channel selection is preference-ordered, NOT hardcoded — many Protect users
 * only enable Share-Livestream for a single channel (often Medium) per cam.
 * The earlier "loxone-mjpeg → quality='low'" / "frigate-rtsp → quality='high'"
 * mapping silently dropped any cam where the chosen channel didn't have a
 * shared rtsp_url, leaving the YAML empty. Live UAT against the Carport cam
 * (only Medium shared) caught this.
 *
 * Per output type, prefer the channel whose source quality best fits the
 * output's downstream use:
 *   - Loxone-MJPEG (640×360@10fps transcode): low > medium > high — low source
 *     means cheaper VAAPI work; medium/high are acceptable fallbacks.
 *   - Frigate-RTSP (passthrough copy): high > medium > low — Frigate wants the
 *     highest available quality, since `-c:v copy` is zero-cost.
 *
 * If a cam has zero shared channels with rtsp_url, the output is silently
 * skipped (yaml-builder tolerates an empty array). This is intentional — it
 * lets the user enable an output toggle ahead of enabling Share-Livestream
 * in Protect, and reconcile picks the cam up automatically once a channel
 * appears.
 */
const MJPEG_PREF: ReadonlyArray<string> = ['low', 'medium', 'high'];
const RTSP_PREF: ReadonlyArray<string> = ['high', 'medium', 'low'];

function loadOutputRows(): OutputRow[] {
	const outputs = db
		.select({
			cameraId: cameras.id,
			mac: cameras.mac,
			outputType: cameraOutputs.outputType
		})
		.from(cameraOutputs)
		.innerJoin(cameras, eq(cameras.id, cameraOutputs.cameraId))
		.where(and(eq(cameras.source, 'external'), eq(cameraOutputs.enabled, true)))
		.all();

	if (outputs.length === 0) return [];

	const catalogRows = db
		.select({
			cameraId: protectStreamCatalog.cameraId,
			quality: protectStreamCatalog.quality,
			rtspUrl: protectStreamCatalog.rtspUrl
		})
		.from(protectStreamCatalog)
		.where(eq(protectStreamCatalog.shareEnabled, true))
		.all();

	const channelsByCam = new Map<number, Array<{ quality: string; rtspUrl: string }>>();
	for (const row of catalogRows) {
		if (!row.rtspUrl) continue;
		const arr = channelsByCam.get(row.cameraId) ?? [];
		arr.push({ quality: row.quality.toLowerCase(), rtspUrl: row.rtspUrl });
		channelsByCam.set(row.cameraId, arr);
	}

	const result: OutputRow[] = [];
	for (const o of outputs) {
		if (!o.mac) continue;
		const channels = channelsByCam.get(o.cameraId);
		if (!channels || channels.length === 0) continue;
		const pref = o.outputType === 'loxone-mjpeg' ? MJPEG_PREF : RTSP_PREF;
		let chosen: { quality: string; rtspUrl: string } | undefined;
		for (const q of pref) {
			chosen = channels.find((c) => c.quality === q);
			if (chosen) break;
		}
		if (!chosen) continue;
		result.push({
			cameraId: o.cameraId,
			mac: o.mac,
			outputType: o.outputType as OutputType,
			rtspUrl: chosen.rtspUrl
		});
	}
	return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: Pass 1b auto-add — seed default outputs for new cams
// ────────────────────────────────────────────────────────────────────────────

/**
 * For every external first-party cam with no `cameraOutputs` row yet, insert
 * a default Loxone-MJPEG row. Third-party cams stay opted-out by default;
 * user enables them via P22 UI.
 *
 * VAAPI-cap-aware seeding: we count currently-enabled mjpeg outputs first,
 * and seed new cams ENABLED only while there's headroom under the hard cap
 * (VAAPI_HARD_CAP). Cams beyond that point are seeded `enabled=false` so the
 * row exists for the UI but reconcile won't auto-attach them. Without this,
 * a fresh install with 7+ first-party cams would auto-create 7+ enabled
 * mjpeg outputs and then every subsequent toggle would hit 422 cap errors —
 * a state caught by live UAT against the Carport bridge.
 *
 * Per HUB-OUT-05 + HUB-RCN-08 + L-28 + L-26.
 */
// P22-UAT 2026-05-16: kept in sync with VAAPI_HARD_CAP in
// /api/cameras/[id]/outputs (raised 6 → 12; see that file's header comment
// for hardware rationale — Intel Core Ultra 7 255H Arrow Lake-P).
const VAAPI_HARD_CAP_FOR_SEEDING = 12;

function seedDefaultOutputsForNewCams(): void {
	const enabledCountRow = db
		.select({ n: sql<number>`count(*)` })
		.from(cameraOutputs)
		.where(
			and(
				eq(cameraOutputs.outputType, 'loxone-mjpeg'),
				eq(cameraOutputs.enabled, true)
			)
		)
		.get();
	let remainingCap = VAAPI_HARD_CAP_FOR_SEEDING - (enabledCountRow?.n ?? 0);

	const newCams = db
		.select()
		.from(cameras)
		.where(eq(cameras.source, 'external'))
		.all();

	for (const cam of newCams) {
		if (cam.kind !== 'first-party') continue; // third-party defaults OFF

		const existing = db
			.select({ id: cameraOutputs.id })
			.from(cameraOutputs)
			.where(eq(cameraOutputs.cameraId, cam.id))
			.get();
		if (existing) continue; // already has outputs (any type)

		const enabled = remainingCap > 0;

		db.insert(cameraOutputs)
			.values({
				cameraId: cam.id,
				outputType: 'loxone-mjpeg',
				enabled,
				config: '{}'
			})
			.run();

		if (enabled) {
			remainingCap--;
			insertEvent({
				cameraId: cam.id,
				cameraName: cam.name,
				eventType: 'protect_hub_cam_added',
				severity: 'info',
				message: `Protect cam '${cam.name}' added; default Loxone-MJPEG output enabled (first-party)`,
				source: 'protect_hub'
			});
		} else {
			insertEvent({
				cameraId: cam.id,
				cameraName: cam.name,
				eventType: 'protect_hub_cam_added',
				severity: 'warning',
				message: `Protect cam '${cam.name}' added; Loxone-MJPEG output created OFF (VAAPI hard cap of ${VAAPI_HARD_CAP_FOR_SEEDING} reached — enable manually after disabling another cam)`,
				source: 'protect_hub'
			});
		}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: Pass 1c soft-delete — archive cams missing from bootstrap
// ────────────────────────────────────────────────────────────────────────────

function softDeleteMissingCams(bootstrapMacs: Set<string>): void {
	const externalCams = db
		.select()
		.from(cameras)
		.where(eq(cameras.source, 'external'))
		.all();

	for (const cam of externalCams) {
		if (!cam.mac) continue;
		if (bootstrapMacs.has(cam.mac)) continue;

		db.update(cameras)
			.set({
				source: 'external_archived',
				updatedAt: new Date().toISOString()
			})
			.where(eq(cameras.id, cam.id))
			.run();

		insertEvent({
			cameraId: cam.id,
			cameraName: cam.name,
			eventType: 'protect_hub_cam_archived',
			severity: 'warning',
			message: `Protect cam '${cam.name}' (${cam.mac}) no longer in bootstrap → soft-deleted (7-day grace)`,
			source: 'protect_hub'
		});
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: Pass 3 mtime fast-path
// ────────────────────────────────────────────────────────────────────────────

interface MtimeCheckResult {
	skip: boolean;
}

/**
 * Read remote /etc/go2rtc/go2rtc.yaml mtime and compare to lastReconciledAt.
 * Within ±MTIME_TOLERANCE_SECONDS → skip (real no-op). Outside tolerance →
 * defensive re-deploy (someone manually edited the file or our DB row drifted).
 *
 * Cost: one `pct exec stat` over SSH ≈ 80ms (Pattern 3). Within the SC-3
 * "<2s reconcile cycle when YAML unchanged" budget.
 */
async function checkMtimeFastPath(
	ssh: Awaited<ReturnType<typeof connectToProxmox>>,
	vmid: number,
	lastReconciledAt: string | null
): Promise<MtimeCheckResult> {
	if (!lastReconciledAt) return { skip: false }; // first deploy
	let statResult: { stdout: string; stderr: string; code: number };
	try {
		statResult = await executeOnContainer(ssh, vmid, `stat -c "%Y" ${FINAL_YAML_PATH}`);
	} catch {
		// stat failed — file may not exist on the bridge (defensive re-deploy).
		return { skip: false };
	}
	const remoteMtime = parseInt(statResult.stdout.trim(), 10);
	if (Number.isNaN(remoteMtime)) return { skip: false };

	const lastDeployMtime = Math.floor(Date.parse(lastReconciledAt) / 1000);
	if (Number.isNaN(lastDeployMtime)) return { skip: false };

	const skew = Math.abs(remoteMtime - lastDeployMtime);
	return { skip: skew <= MTIME_TOLERANCE_SECONDS };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: audit-row helpers
// ────────────────────────────────────────────────────────────────────────────

function insertRunRow(reconcileId: string): void {
	db.insert(protectHubReconcileRuns)
		.values({
			reconcileId,
			status: 'running',
			hashChanged: false,
			deployedYamlHash: null,
			error: null
		})
		.run();
}

function updateRunRow(
	reconcileId: string,
	patch: {
		status: 'success' | 'no_op' | 'bridge_unreachable' | 'error';
		hashChanged?: boolean;
		deployedYamlHash?: string | null;
		error?: string;
	}
): void {
	db.update(protectHubReconcileRuns)
		.set({
			status: patch.status,
			hashChanged: patch.hashChanged ?? false,
			deployedYamlHash: patch.deployedYamlHash ?? null,
			error: patch.error ?? null,
			completedAt: new Date().toISOString()
		})
		.where(eq(protectHubReconcileRuns.reconcileId, reconcileId))
		.run();
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: error classification — heuristic for bridge_unreachable vs error
// ────────────────────────────────────────────────────────────────────────────

const BRIDGE_ERROR_PATTERNS = [
	/connect ETIMEDOUT/i,
	/connect ECONNREFUSED/i,
	/ENETUNREACH/i,
	/EHOSTUNREACH/i,
	/ssh.*connect/i,
	/pct.*exec/i,
	/pct.*push/i
];

function isLikelyBridgeError(message: string): boolean {
	return BRIDGE_ERROR_PATTERNS.some((re) => re.test(message));
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: event emission
//
// We bypass `storeEvent()` from `services/events.ts` because its `EventType`
// union (`src/lib/types.ts:220`) is closed over the legacy v1.0 event names
// (camera_disconnect / camera_reconnect / stream_failed / adoption_changed /
// aiport_error). Reconcile events are admin-flow (not per-camera-stream)
// and belong to the new Protect Hub event family. P23 will widen the union
// when it builds the reconcile-log UI; for now we INSERT directly so we
// don't have to extend types.ts (declared out-of-scope by 21-03-PLAN
// `files_modified`).
// ────────────────────────────────────────────────────────────────────────────

interface ReconcileEventInput {
	cameraId: number | null;
	cameraName: string;
	eventType: string;
	severity: 'info' | 'warning' | 'error';
	message: string;
	source: string;
}

function insertEvent(input: ReconcileEventInput): void {
	db.insert(events)
		.values({
			cameraId: input.cameraId,
			cameraName: input.cameraName,
			eventType: input.eventType,
			severity: input.severity,
			message: input.message,
			source: input.source,
			timestamp: new Date().toISOString()
		})
		.run();
}

function emitReconcileEvent(
	reconcileId: string,
	kind: 'deployed' | 'noop' | 'error',
	message: string,
	_outputCount: number,
	_hash: string | null
): void {
	const eventType =
		kind === 'deployed'
			? 'reconcile_deployed'
			: kind === 'noop'
				? 'reconcile_noop'
				: 'reconcile_error';
	const severity: 'info' | 'warning' | 'error' = kind === 'error' ? 'error' : 'info';
	insertEvent({
		cameraId: null,
		cameraName: 'Protect Hub',
		eventType,
		severity,
		message,
		source: 'protect_hub'
	});
	void reconcileId; // referenced in `message` already; helper signature kept for future fields
}
