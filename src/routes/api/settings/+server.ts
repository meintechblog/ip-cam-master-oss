import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSettings, saveSettings } from '$lib/server/services/settings';
import { validateProxmoxConnection } from '$lib/server/services/proxmox';

export const GET: RequestHandler = async () => {
	const proxmox = await getSettings('proxmox_');
	const unifi = await getSettings('unifi_');

	return json({ proxmox, unifi });
};

export const PUT: RequestHandler = async ({ request }) => {
	const data: Record<string, string> = await request.json();
	await saveSettings(data);

	// Auto-validate Proxmox connection if any proxmox settings were saved (D-06)
	const hasProxmoxKeys = Object.keys(data).some((key) => key.startsWith('proxmox_'));
	let validation;
	if (hasProxmoxKeys) {
		validation = await validateProxmoxConnection();
	}

	return json({ saved: true, validation });
};
