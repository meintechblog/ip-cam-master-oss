/**
 * POST /api/update/ack-rollback
 *
 * Clears the rollback banner fields in state.json after the user
 * dismisses it from the Settings UI. Localhost-only (UPD-AUTO-12).
 *
 * Idempotent: clearing already-clear fields is a no-op.
 */

import { json } from '@sveltejs/kit';
import { writeUpdateState } from '$lib/server/services/update-state-store';
import type { RequestHandler } from './$types';

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLocalhostRequest(request: Request): boolean {
	const host = request.headers.get('host') ?? '';
	const hostname = host.split(':')[0]?.toLowerCase() ?? '';
	return LOCAL_HOSTS.has(hostname);
}

export const POST: RequestHandler = async ({ request }) => {
	if (!isLocalhostRequest(request)) {
		return json({ error: 'localhost_only' }, { status: 403 });
	}

	writeUpdateState({
		rollbackHappened: false,
		rollbackReason: null,
		rollbackStage: null,
		// Once the user acks, the previous run's terminal state isn't relevant
		// anymore — bring updateStatus back to idle so the next install starts
		// from a clean state.
		updateStatus: 'idle'
	});

	return json({ status: 'acked' });
};
