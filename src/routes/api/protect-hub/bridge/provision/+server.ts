// v1.3 Phase 20 — POST /api/protect-hub/bridge/provision.
// Blocking request (D-PROV-06): may take 10s (template clone) to 5min (raw create).
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { provisionBridge } from '$lib/server/orchestration/protect-hub/bridge-provision';

export const POST: RequestHandler = async () => {
	try {
		const result = await provisionBridge();
		if (!result.ok) {
			return json({ ok: false, error: result.error }, { status: 500 });
		}
		return json({ ok: true, bridge: result.bridge });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
