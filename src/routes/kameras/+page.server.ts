// v1.3 Phase 22 Plan 03 Task 1 — /kameras loader extension.
// Adds `hubEnabled` (gates the "Aus UniFi Protect" section) and `bridgeIp`
// (passed into ExternalCamCard for snapshot URL + slug derivation).
import { listContainers } from '$lib/server/services/proxmox';
import { getSetting, getSettings } from '$lib/server/services/settings';
import { getBridgeStatus } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';
import { loadCatalog } from '$lib/server/orchestration/protect-hub/catalog';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Hub flags load even when proxmox isn't configured — the partition still
	// needs to know whether to render the "Aus UniFi Protect" section.
	const hubEnabled = (await getSetting('protect_hub_enabled')) === 'true';
	const bridge = getBridgeStatus();
	const bridgeIp = bridge?.containerIp ?? null;

	// WR-05 fix — surface the most recent catalog discovery timestamp so the
	// external-section empty-state copy can render
	// "Letzte Synchronisation: {ts}" per UI-SPEC line 219. loadCatalog()
	// derives lastDiscoveredAt from MAX(cachedAt) across protect_stream_catalog;
	// safe to call even when hub is disabled (returns null on no rows).
	let lastDiscoveredAt: number | null = null;
	try {
		const catalogState = await loadCatalog();
		lastDiscoveredAt = catalogState.lastDiscoveredAt;
	} catch {
		// Best-effort — empty-state caption falls back to no timestamp.
	}

	try {
		const settings = await getSettings('proxmox_');
		const proxmoxConfigured = !!(settings.proxmox_host && settings.proxmox_token_id && settings.proxmox_token_secret);
		const containers = proxmoxConfigured ? await listContainers() : [];
		return { containers, error: null, proxmoxConfigured, hubEnabled, bridgeIp, lastDiscoveredAt };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Container konnten nicht geladen werden';
		return { containers: [], error: message, proxmoxConfigured: false, hubEnabled, bridgeIp, lastDiscoveredAt };
	}
};
