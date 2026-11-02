/**
 * GET /api/version
 *
 * Health-check + reconnect-overlay polling endpoint. Returns the
 * running app's SHA/build info plus a live db-health probe.
 *
 * Used by:
 *   - The reconnect overlay during a self-update install (UPD-AUTO-05):
 *     polls every 2s until the SHA changes AND dbHealthy=true.
 *   - The bash update.sh `verify` stage: requires sha === target_sha
 *     AND dbHealthy=true within 60s, else triggers two-stage rollback.
 *
 * No-cache headers are required — stale responses would cause the
 * verify stage to never see the new SHA, hanging at 60s timeout.
 */

import { json } from '@sveltejs/kit';
import { CURRENT_SHA, CURRENT_SHA_SHORT, BUILD_TIME } from '$lib/version';
import { db } from '$lib/server/db/client';
import { sql } from 'drizzle-orm';
import { readUpdateState } from '$lib/server/services/update-state-store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	let dbHealthy = false;
	try {
		const result = db.get<{ ok: number }>(sql`SELECT 1 as ok`);
		dbHealthy = result?.ok === 1;
	} catch {
		dbHealthy = false;
	}

	const state = readUpdateState();

	return json(
		{
			sha: CURRENT_SHA || 'unknown',
			shaShort: CURRENT_SHA_SHORT || 'unknown',
			buildTime: BUILD_TIME,
			dbHealthy,
			rollbackSha: state.rollbackSha,
			updateStatus: state.updateStatus
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
