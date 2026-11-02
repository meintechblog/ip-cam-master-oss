// v1.3 Phase 22 Plan 02 — GET /api/protect-hub/events (filtered event log read).
//
// Scope: source='protect_hub' (reconcile_deployed / reconcile_noop /
// reconcile_error / vaapi_soft_cap_warning / protect_hub_cam_added /
// protect_hub_cam_archived). The reconciler INSERTs these directly into the
// `events` table with that source string (reconcile.ts:721-733).
//
// Default limit=50, hard-capped at 200 (T-22-08 mitigation — prevents
// unbounded reads). Newest-first ordering already guaranteed by getEvents().
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEvents } from '$lib/server/services/events';

export const GET: RequestHandler = async ({ url }) => {
	const limitRaw = url.searchParams.get('limit');
	const limitParsed = limitRaw !== null ? Number(limitRaw) : 50;
	if (Number.isNaN(limitParsed)) {
		return json({ ok: false, error: 'invalid limit' }, { status: 400 });
	}
	const limit = Math.min(200, Math.max(1, limitParsed));
	try {
		const result = getEvents({ source: 'protect_hub', limit });
		return json({ ok: true, events: result.events, total: result.total });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
