import type { PageServerLoad } from './$types';
import { getNextVmid } from '$lib/server/services/onboarding';
import { getSettings } from '$lib/server/services/settings';
import { redirect } from '@sveltejs/kit';

export const load: PageServerLoad = async () => {
	const settings = await getSettings('proxmox_');
	if (!settings.proxmox_host || !settings.proxmox_token_id || !settings.proxmox_token_secret) {
		redirect(302, '/settings');
	}
	const nextVmid = await getNextVmid();
	return { nextVmid };
};
