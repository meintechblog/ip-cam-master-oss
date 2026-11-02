import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainers, createContainer } from '$lib/server/services/proxmox';

export const GET: RequestHandler = async () => {
	try {
		const containers = await listContainers();
		return json(containers);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { vmid, hostname, ostemplate, memory, cores, cameraName, cameraIp, cameraType } = body;

		if (!vmid || !hostname) {
			return json({ error: 'vmid and hostname are required' }, { status: 400 });
		}

		const result = await createContainer({
			vmid,
			hostname,
			ostemplate,
			memory,
			cores,
			cameraName,
			cameraIp,
			cameraType
		});
		return json(result, { status: 201 });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: 500 });
	}
};
