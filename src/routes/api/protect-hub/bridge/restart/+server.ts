// v1.3 Phase 20 — POST /api/protect-hub/bridge/restart.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { restartBridge } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';

export const POST: RequestHandler = async () => {
	try {
		const result = await restartBridge();
		if (!result.ok) {
			return json({ ok: false, error: result.error }, { status: 500 });
		}
		return json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
