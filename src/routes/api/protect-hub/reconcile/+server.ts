// v1.3 Phase 21 Plan 05 — POST /api/protect-hub/reconcile (force-reconcile).
//
// Non-blocking per D-API-01: returns 202 + { ok: true, reconcileId } IMMEDIATELY,
// then spawns reconcile() in the background as fire-and-forget. The client polls
// `GET /api/protect-hub/reconcile-runs?reconcileId=…` for status (the same id
// is the audit-row primary key — see Plan 05 Task 1: reconcile.ts now accepts
// `externalReconcileId` so the API-returned id matches the runs row).
//
// 503 when no bridge is in status='running' (single-bridge MVP per v1.3 scope).
//
// Auth: handled by the global hooks.server.ts handler (this path is NOT in
// PUBLIC_PATHS). Acceptable per L-23 LAN-trust posture (T-21-04 disposition).
//
// Single-flight: reconcile.ts internally serialises concurrent calls (Pattern 1
// + L-13 + P21-#6); flooding this endpoint cannot amplify load (T-21-02).
import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { protectHubBridges } from '$lib/server/db/schema';
import { reconcile } from '$lib/server/orchestration/protect-hub/reconcile';

export const POST: RequestHandler = async () => {
	const bridge = db
		.select()
		.from(protectHubBridges)
		.where(eq(protectHubBridges.status, 'running'))
		.limit(1)
		.get();

	if (!bridge) {
		return json(
			{ ok: false, reason: 'no_running_bridge', error: 'no running bridge' },
			{ status: 503 }
		);
	}

	const reconcileId = randomUUID();

	// Fire-and-forget per D-API-01. reconcile.ts manages single-flight,
	// audit-log row creation, atomic SSH push, and error classification
	// internally. Pass externalReconcileId so the runs row matches what
	// we just returned to the caller (Plan 05 Task 1 extension).
	void reconcile(bridge.id, 'force', reconcileId).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[POST /api/protect-hub/reconcile] background reconcile failed:', msg);
	});

	return json({ ok: true, reconcileId }, { status: 202 });
};
