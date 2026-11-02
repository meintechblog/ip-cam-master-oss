// v1.3 Phase 21 Plan 05 — GET /api/protect-hub/reconcile-runs?reconcileId=…
//
// Poll endpoint for reconcile run status. The companion to
// POST /api/protect-hub/reconcile: client receives a reconcileId in the 202
// response, then polls this endpoint until the row reaches a terminal status
// (success | no_op | bridge_unreachable | error).
//
// P21 ships only by-id GET; the "last 50 runs" UI feed lives in P22's reconcile-log
// surface. Keep this endpoint focused on by-id polling.
//
// 400 when reconcileId is missing (param required); 404 when the row is not
// (yet) present — clients should retry with the same id, since the audit row
// is INSERTed at the start of reconcile() but a race with the 202 response
// is technically possible (the background `void reconcile(...)` may not have
// run its insertRunRow() yet by the time the client polls).
//
// Auth: handled by the global hooks.server.ts handler (T-21-13 — error column
// may include hostnames/IPs but never credentials; LAN-trust posture).
import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { protectHubReconcileRuns } from '$lib/server/db/schema';

export const GET: RequestHandler = async ({ url }) => {
	const reconcileId = url.searchParams.get('reconcileId');
	if (!reconcileId) {
		return json(
			{ ok: false, error: 'reconcileId query parameter is required' },
			{ status: 400 }
		);
	}

	const row = db
		.select()
		.from(protectHubReconcileRuns)
		.where(eq(protectHubReconcileRuns.reconcileId, reconcileId))
		.get();

	if (!row) {
		return json({ ok: false, error: 'not found' }, { status: 404 });
	}

	return json({ ok: true, run: row });
};
