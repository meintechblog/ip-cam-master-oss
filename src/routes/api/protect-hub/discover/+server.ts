// v1.3 Phase 19 Plan 03 — POST /api/protect-hub/discover.
// Thin wrapper around catalog.discover(). Auth-gating is handled by the
// global hooks.server.ts handler (this path is NOT in PUBLIC_PATHS).
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discover } from '$lib/server/orchestration/protect-hub/catalog';

export const POST: RequestHandler = async () => {
	try {
		const result = await discover();
		if (!result.ok) {
			const status =
				result.reason === 'controller_unreachable'
					? 503
					: result.reason === 'auth_failed'
						? 401
						: 500;
			return json(
				{
					ok: false,
					reason: result.reason,
					error: result.error.message
				},
				{ status }
			);
		}
		return json({
			ok: true,
			insertedCams: result.insertedCams,
			updatedCams: result.updatedCams,
			insertedChannels: result.insertedChannels
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
