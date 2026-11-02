// v1.3 Phase 21 Plan 04 — WebSocket reconnect singleton.
//
// Wraps `unifi-protect@4.29.0` ProtectApi (which does NOT auto-reconnect
// per CITED [hjdhjd/unifi-protect/src/protect-api.ts] — `_eventsWs` is
// nullified on close with no internal backoff). HUB-RCN-07 requires reconnect
// so the app keeps detecting cam adds/removes after a UDM reboot.
//
// Patterns:
//  - Module-scoped singleton with start/stop guards (Pattern S-6;
//    analog: `services/update-checker.ts:189-219`).
//  - Backoff state machine (RESEARCH §Pattern 4):
//    BACKOFF_SCHEDULE_MS = [5,10,30,60,120,300] s, single-flight
//    `_reconnectingPromise`, `_attempt` counter capped at schedule length.
//  - On every successful (re)connect, fires `reconcile(bridgeId, 'ws_reconnect')`
//    once — refreshes share-livestream tokens that may have rotated during
//    the disconnect (PITFALLS #1 / P21-#1).
//
// Cyclic-import warning: ws-manager imports `reconcile` from './reconcile'
// (one-way). reconcile MUST NOT import ws-manager. Verify with:
//   grep "ws-manager" src/lib/server/orchestration/protect-hub/reconcile.ts
// (expected: 0 matches). See PATTERNS.md §ws-manager.ts.
//
// stopWs() additionally calls `resetProtectClient()` so a future startWs()
// performs a fresh login rather than reusing the lib's 8-min cached session.

import { db } from '$lib/server/db/client';
import { protectHubBridges } from '$lib/server/db/schema';
import { getProtectClient, resetProtectClient } from '$lib/server/services/protect-bridge';
import { reconcile } from './reconcile';

/**
 * Per L-12 + D-API-05 — exponential backoff cap 5 min.
 * Locked; do not adjust without re-running the WS reconnect storm test
 * (see ws-manager.test.ts + RESEARCH §Pitfall P21-#3).
 */
export const BACKOFF_SCHEDULE_MS = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000] as const;

// ────────────────────────────────────────────────────────────────────────────
// Module-scoped singleton state.
// ────────────────────────────────────────────────────────────────────────────
let _attempt = 0;
let _reconnectingPromise: Promise<void> | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _stopped = false;
let _started = false;

/**
 * Idempotent start — calling twice is a no-op while running.
 * Resets internal counters and kicks off the first connect attempt.
 */
export async function startWs(): Promise<void> {
	if (_started) return;
	_started = true;
	_stopped = false;
	_attempt = 0;
	await connectAndListen();
}

/**
 * Cancels in-flight backoff timer (if any) and clears module state so a
 * subsequent startWs() begins from a clean slate. Also calls
 * `resetProtectClient()` so the next startWs performs a fresh login.
 *
 * Safe to call without a prior startWs() — idempotent.
 */
export function stopWs(): void {
	_stopped = true;
	_started = false;
	if (_reconnectTimer) {
		clearTimeout(_reconnectTimer);
		_reconnectTimer = null;
	}
	_reconnectingPromise = null;
	_attempt = 0;
	resetProtectClient();
}

/**
 * Single attempt: get the lib client, run getBootstrap (which also launches
 * the events WS internally per the lib's source), wire a 'login' listener
 * that triggers a reconnect on `success === false`, and fire one
 * `reconcile(bridgeId, 'ws_reconnect')` to refresh stream tokens.
 *
 * On failure, schedules the next reconnect according to BACKOFF_SCHEDULE_MS.
 */
async function connectAndListen(): Promise<void> {
	try {
		const client = await getProtectClient();
		const ok = await client.getBootstrap();
		if (!ok) {
			scheduleReconnect();
			return;
		}
		_attempt = 0;

		// Detect future disconnects via 'login' false event. The lib emits
		// `login` on (re)login attempts; a false value means the session has
		// died and the client cannot recover on its own.
		client.on('login', (success: boolean) => {
			if (!success && !_stopped) scheduleReconnect();
		});

		// After a successful (re)connect, force a reconcile to refresh
		// share-livestream URLs whose tokens may have rotated during the
		// disconnect (PITFALLS #1 — P21-#1 mitigation).
		const bridge = db.select().from(protectHubBridges).get();
		if (bridge) {
			void reconcile(bridge.id, 'ws_reconnect').catch((err: unknown) => {
				console.error('[ws-manager] reconcile-on-reconnect failed:', err);
			});
		}
	} catch (err) {
		console.error('[ws-manager] connect failed:', (err as Error).message);
		scheduleReconnect();
	}
}

/**
 * Single-flight reconnect scheduler. Subsequent calls during an in-flight
 * timer coalesce (no storm). Increments `_attempt` once per scheduled try
 * and clamps the index at the end of BACKOFF_SCHEDULE_MS so the cap stays
 * at 5 minutes.
 */
function scheduleReconnect(): void {
	if (_stopped) return;
	if (_reconnectingPromise) return; // single-flight per L-12 + P21-#3 mitigation

	const delay = BACKOFF_SCHEDULE_MS[Math.min(_attempt, BACKOFF_SCHEDULE_MS.length - 1)];
	_attempt++;

	_reconnectingPromise = new Promise<void>((resolve) => {
		_reconnectTimer = setTimeout(async () => {
			_reconnectTimer = null;
			_reconnectingPromise = null;
			if (_stopped) {
				resolve();
				return;
			}
			await connectAndListen();
			resolve();
		}, delay);
	});
}
