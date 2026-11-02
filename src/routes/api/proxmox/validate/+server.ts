import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateProxmoxConnection } from '$lib/server/services/proxmox';

export const POST: RequestHandler = async () => {
	const result = await validateProxmoxConnection();
	return json(result);
};
