// v1.3 Phase 22 Plan 02 — POST /api/protect-hub/wizard/reset (clear pointer).
//
// Deletes the single hub_onboarding_state row (resetPointer DELETE WHERE id=1).
// Plan 04 wires this to the "Reset" button on the resume banner. Idempotent:
// no-op when the row is already absent.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resetPointer } from '$lib/server/orchestration/protect-hub/wizard-state';

export const POST: RequestHandler = async () => {
	try {
		resetPointer();
		return json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
