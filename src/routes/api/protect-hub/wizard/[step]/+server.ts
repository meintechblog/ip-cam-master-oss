// v1.3 Phase 22 Plan 02 — POST /api/protect-hub/wizard/[step] (advance pointer).
//
// Validates step ∈ {1..6} and upserts hub_onboarding_state (id=1, status='in_progress').
// Plan 04 wizard step components POST here on auto-advance + after the user
// resumes via the resume banner. Plan 04 Step 6 calls /wizard/complete instead.
//
// Threat: T-22-03 (Tampering on step parameter) — mitigated via the strict
// integer-range guard. Out-of-range values return 400 with the standard
// `{ ok: false, error }` envelope.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setPointer } from '$lib/server/orchestration/protect-hub/wizard-state';

export const POST: RequestHandler = async ({ params }) => {
	const step = Number(params.step);
	if (!Number.isInteger(step) || step < 1 || step > 6) {
		return json({ ok: false, error: 'invalid step' }, { status: 400 });
	}
	try {
		setPointer(step);
		return json({ ok: true, step });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
