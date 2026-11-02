// v1.3 Phase 20 — GET /api/protect-hub/bridge/status.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBridgeStatus } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';

export const GET: RequestHandler = async () => {
	const bridge = getBridgeStatus();
	return json({ bridge });
};
