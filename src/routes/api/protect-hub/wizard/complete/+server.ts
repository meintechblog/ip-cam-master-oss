// v1.3 Phase 22 Plan 02 — POST /api/protect-hub/wizard/complete.
//
// Atomic state transition for HUB-WIZ-10: flip settings.protect_hub_enabled='true'
// and mark hub_onboarding_state pointer status='completed' in strict order so the
// system never observes "enabled but pointer not completed" (the inverse is fine
// — a retried call from the user idempotently re-completes the pointer).
//
// Order matters (T-22-07 mitigation):
//   1. saveSetting('protect_hub_enabled', 'true')   — feature flag flips
//   2. completePointer()                             — pointer reaches terminal state
// If (1) throws → (2) is NOT called, both stay un-flipped, user retries.
// If (2) throws → setting is already true; user retries → completePointer is
//   idempotent (UPSERT), no harm done.
//
// Note: saveSetting is async (it invalidates the settings cache + may trigger
// resetProtectClient on unifi_* keys); we await it before calling completePointer.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { saveSetting } from '$lib/server/services/settings';
import { completePointer } from '$lib/server/orchestration/protect-hub/wizard-state';

export const POST: RequestHandler = async () => {
	try {
		await saveSetting('protect_hub_enabled', 'true');
		completePointer();
		return json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
