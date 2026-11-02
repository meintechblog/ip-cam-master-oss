import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startContainer } from '$lib/server/services/proxmox';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const vmid = parseInt(params.vmid);
		if (isNaN(vmid)) {
			return json({ error: 'Invalid VMID' }, { status: 400 });
		}
		await startContainer(vmid);
		return json({ success: true, vmid, action: 'started' });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: 500 });
	}
};
