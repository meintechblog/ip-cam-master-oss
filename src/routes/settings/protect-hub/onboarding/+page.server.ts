// v1.3 Phase 22 Plan 04 — Wizard data loader for the 6-step onboarding flow.
//
// Replaces the P20 loader (which redirected to /settings whenever the bridge was
// running). P22 keeps the wizard route open for Steps 3-6: the redirect now only
// fires when the feature flag protect_hub_enabled='true' AND the wizard pointer
// is null/completed (true post-onboarding state — there is nothing left to do).
//
// When the user is at Step 3 or later, we additionally load the catalog so
// Step 4 can render the cam-pick rows without a separate fetch round-trip.
// Pre-flight grep verified `loadCatalog` is exported from
// `$lib/server/orchestration/protect-hub/catalog.ts:173`; no fallback required.
import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getSetting, getSettings } from '$lib/server/services/settings';
import { getBridgeStatus } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';
import { getPointer } from '$lib/server/orchestration/protect-hub/wizard-state';
import { loadCatalog } from '$lib/server/orchestration/protect-hub/catalog';

export const load: PageServerLoad = async () => {
	const enabled = (await getSetting('protect_hub_enabled')) === 'true';
	const pointer = getPointer();
	const bridge = getBridgeStatus();

	// Post-onboarding: feature flag on AND no in-progress pointer → user shouldn't be here.
	if (enabled && (!pointer || pointer.status === 'completed')) {
		redirect(303, '/settings');
	}

	const unifi = await getSettings('unifi_');
	const credsConfigured = !!(unifi.unifi_host && unifi.unifi_username && unifi.unifi_password);

	// Load catalog for Step 4 prefill if the user is at step 3+.
	let protectCams: Array<{
		id: number;
		name: string;
		kind: string | null;
		manufacturer: string | null;
		modelName: string | null;
	}> = [];
	if (pointer && pointer.step >= 3) {
		try {
			const cat = await loadCatalog();
			protectCams = cat.cams.map((c) => ({
				id: c.id,
				name: c.name,
				kind: c.kind,
				manufacturer: c.manufacturer,
				modelName: c.modelName
			}));
		} catch {
			protectCams = [];
		}
	}

	return { pointer, bridge, credsConfigured, protectCams };
};
