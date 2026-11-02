// v1.3 Phase 22 Plan 02 — GET /api/protect-hub/wizard/state.
//
// Returns the current wizard pointer (or null) read from hub_onboarding_state.
// Plan 04's host page reads this to render the "Du warst bei Schritt N — weiter?"
// resume banner across browser-close + SvelteKit restart (HUB-WIZ-09).
//
// Read-only: no side effects, no try/catch needed (pure DB SELECT via getPointer
// which itself returns null on miss).
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPointer } from '$lib/server/orchestration/protect-hub/wizard-state';

export const GET: RequestHandler = async () => {
	const pointer = getPointer();
	return json({ pointer });
};
