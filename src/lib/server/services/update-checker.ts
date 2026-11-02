/**
 * Self-update scheduler decision engine — see UPD-AUTO-02 / UPD-AUTO-08.
 *
 * Two ticks:
 *   - check tick (6h): calls checkForUpdate() to refresh state.json
 *   - auto-update opportunity tick (5min): decides whether to install
 *     based on settings + active flows + 23h spacing
 *
 * Both run via the SvelteKit scheduler — registered in hooks.server.ts
 * after `startScheduler()` so the existing scheduler's `stopScheduler()`
 * (called by the drain endpoint) doesn't kill them. We use module-local
 * timer handles instead.
 */

import { spawn } from 'node:child_process';
import { checkForUpdate } from './update-check';
import { getCurrentVersion } from './version';
import { readUpdateState, writeUpdateState } from './update-state-store';
import { getSetting } from './settings';
import { db } from '$lib/server/db/client';
import { protectHubBridges } from '$lib/server/db/schema';
// v1.3 Phase 21 (CR-4 + HUB-RCN-10) — gate self-update on the Protect Hub
// reconciler's busy state. The atomic tmp+rename SSH push in reconcile.ts
// must not be cut mid-deploy by an updater systemctl restart.
import { isReconcilerBusy } from '$lib/server/orchestration/protect-hub/reconcile';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const AUTO_UPDATE_TICK_MS = 5 * 60 * 1000; // 5min
const MIN_AUTO_UPDATE_GAP_MS = 23 * 60 * 60 * 1000; // 23h
const TIMEZONE = 'Europe/Berlin';
const UPDATER_SERVICE = 'ip-cam-master-updater.service';

let checkTimer: ReturnType<typeof setInterval> | null = null;
let autoUpdateTimer: ReturnType<typeof setInterval> | null = null;
let lastSkipReason = '';

/**
 * Returns the wall-clock hour (0-23) in Europe/Berlin for `now`.
 */
export function currentHourInBerlin(now: Date = new Date()): number {
	const fmt = new Intl.DateTimeFormat('de-DE', {
		hour: 'numeric',
		hour12: false,
		timeZone: TIMEZONE
	});
	const parts = fmt.formatToParts(now);
	const hourPart = parts.find((p) => p.type === 'hour');
	if (!hourPart) return now.getUTCHours();
	const parsed = Number.parseInt(hourPart.value, 10);
	return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
}

/**
 * Reads in-flight Hub state and returns conflicting flows. The downstream
 * HTTP 409 + Retry-After:60 wrapper lives in `routes/api/update/run/+server.ts`.
 *
 * v1.3 Phase 21 (CR-4 + HUB-RCN-10): widened with `reconciler_busy` so the
 * self-update flow honours the in-flight Protect Hub reconcile (atomic
 * tmp+rename inside the bridge LXC must complete before systemctl restart).
 */
export type FlowConflict =
	| { kind: 'hub_starting' | 'hub_stopping'; detail: string }
	| { kind: 'reconciler_busy'; detail: string };

export function getActiveFlowConflicts(): FlowConflict[] {
	const conflicts: FlowConflict[] = [];
	try {
		const bridge = db.select().from(protectHubBridges).get();
		if (bridge?.status === 'starting' || bridge?.status === 'stopping') {
			conflicts.push({
				kind: bridge.status === 'starting' ? 'hub_starting' : 'hub_stopping',
				detail: `Protect Hub bridge VMID ${bridge.vmid} is ${bridge.status}`
			});
		}
	} catch {
		// Hub tables may not exist yet (P19 not deployed) — treat as no conflict
	}
	try {
		if (isReconcilerBusy()) {
			conflicts.push({
				kind: 'reconciler_busy',
				detail: 'Protect Hub reconcile in progress'
			});
		}
	} catch {
		// reconcile module may not be loaded yet (early boot) — treat as no conflict
	}
	return conflicts;
}

function logSkip(reason: string): void {
	if (reason === lastSkipReason) return;
	lastSkipReason = reason;
	console.log(`[update-checker] auto-update skipped: ${reason}`);
}

/**
 * Single auto-update opportunity tick. Reads settings + state, makes a
 * decision, optionally spawns the updater unit.
 */
export async function maybeAutoUpdate(now: Date = new Date()): Promise<{
	triggered: boolean;
	reason: string;
}> {
	try {
		const enabledRaw = await getSetting('update.autoUpdate');
		if (enabledRaw !== 'true') {
			logSkip('auto-update disabled');
			return { triggered: false, reason: 'disabled' };
		}

		const hourRaw = (await getSetting('update.autoUpdateHour')) ?? '3';
		const targetHour = Number.parseInt(hourRaw, 10);
		if (!Number.isFinite(targetHour) || targetHour < 0 || targetHour > 23) {
			logSkip('invalid hour setting');
			return { triggered: false, reason: 'invalid_hour' };
		}

		const currentHour = currentHourInBerlin(now);
		if (currentHour !== targetHour) {
			logSkip(`outside window (current=${currentHour}, target=${targetHour})`);
			return { triggered: false, reason: 'outside_window' };
		}

		const lastAutoRaw = await getSetting('update.lastAutoUpdateAt');
		if (lastAutoRaw) {
			const lastMs = Number.parseInt(lastAutoRaw, 10);
			if (Number.isFinite(lastMs) && now.getTime() - lastMs < MIN_AUTO_UPDATE_GAP_MS) {
				logSkip('within 23h of last auto-update');
				return { triggered: false, reason: 'gap' };
			}
		}

		const state = readUpdateState();
		if (state.updateStatus === 'installing') {
			logSkip('already installing');
			return { triggered: false, reason: 'already_running' };
		}

		const last = state.lastCheckResult;
		if (!last || last.status !== 'ok') {
			logSkip('no fresh remote info — waiting on next 6h check');
			return { triggered: false, reason: 'no_remote' };
		}

		const current = await getCurrentVersion();
		if (current.isDev || current.isDirty) {
			logSkip('dev/dirty');
			return { triggered: false, reason: 'dev_or_dirty' };
		}
		if (last.remoteSha === current.sha) {
			logSkip('up-to-date');
			return { triggered: false, reason: 'up_to_date' };
		}

		const conflicts = getActiveFlowConflicts();
		if (conflicts.length > 0) {
			logSkip(`active flow: ${conflicts.map((c) => c.kind).join(',')}`);
			return { triggered: false, reason: 'active_flow' };
		}

		// All gates clear — fire the updater unit.
		writeUpdateState({
			updateStatus: 'installing',
			targetSha: last.remoteSha,
			updateStartedAt: now.toISOString()
		});
		// Best-effort settings write so the next tick respects 23h spacing.
		try {
			const { saveSetting } = await import('./settings');
			await saveSetting('update.lastAutoUpdateAt', String(now.getTime()));
		} catch {
			/* tolerate */
		}

		const child = spawn('systemctl', ['start', '--no-block', UPDATER_SERVICE], {
			detached: true,
			stdio: 'ignore'
		});
		child.unref();

		console.log(
			`[update-checker] auto-update triggered → ${UPDATER_SERVICE} target=${last.remoteShaShort}`
		);
		lastSkipReason = '';
		return { triggered: true, reason: 'ok' };
	} catch (err) {
		console.error('[update-checker] maybeAutoUpdate failed:', (err as Error).message);
		return { triggered: false, reason: 'error' };
	}
}

/**
 * Periodic GitHub poll. Bypasses the 5-min cooldown (the cooldown is
 * meant to throttle user-driven manual checks, not the scheduler).
 */
export async function performScheduledCheck(): Promise<void> {
	try {
		const current = await getCurrentVersion();
		if (current.isDev) return;
		await checkForUpdate({ enforceCooldown: false });
	} catch (err) {
		console.error('[update-checker] check failed:', (err as Error).message);
	}
}

/**
 * Start the two ticks. Idempotent — calling twice is a no-op.
 */
export function startUpdateChecker(): void {
	if (checkTimer === null) {
		// Run once shortly after boot, then every 6h.
		setTimeout(() => {
			performScheduledCheck();
		}, 30_000);
		checkTimer = setInterval(performScheduledCheck, CHECK_INTERVAL_MS);
	}
	if (autoUpdateTimer === null) {
		autoUpdateTimer = setInterval(() => {
			maybeAutoUpdate().catch((err) =>
				console.error('[update-checker] auto-update tick failed:', err)
			);
		}, AUTO_UPDATE_TICK_MS);
	}
	console.log(
		`[update-checker] started: check ${CHECK_INTERVAL_MS / 3600_000}h, auto-update tick ${AUTO_UPDATE_TICK_MS / 60_000}min, tz=${TIMEZONE}`
	);
}

export function stopUpdateChecker(): void {
	if (checkTimer) {
		clearInterval(checkTimer);
		checkTimer = null;
	}
	if (autoUpdateTimer) {
		clearInterval(autoUpdateTimer);
		autoUpdateTimer = null;
	}
}
