import { getSettings } from '$lib/server/services/settings';
import { isYoloMode } from '$lib/server/services/auth';
import { getCurrentVersion, formatVersionLabel } from '$lib/server/services/version';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const proxmox = await getSettings('proxmox_');
	const unifi = await getSettings('unifi_');
	const version = await getCurrentVersion().catch(() => null);
	return {
		configured: {
			proxmox: !!(proxmox.proxmox_host && proxmox.proxmox_token_id && proxmox.proxmox_token_secret),
			unifi: !!(unifi.unifi_host && unifi.unifi_username)
		},
		user: locals.user ?? null,
		isYolo: isYoloMode(),
		version: version
			? { label: formatVersionLabel(version), isDirty: version.isDirty, isDev: version.isDev }
			: null
	};
};
