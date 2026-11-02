import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteContainer, getContainerStatus } from '$lib/server/services/proxmox';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const vmid = parseInt(params.vmid);
		if (isNaN(vmid)) {
			return json({ error: 'Invalid VMID' }, { status: 400 });
		}
		const status = await getContainerStatus(vmid);
		return json(status);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		const vmid = parseInt(params.vmid);
		if (isNaN(vmid)) {
			return json({ error: 'Invalid VMID' }, { status: 400 });
		}
		await deleteContainer(vmid);
		// Also remove from cameras DB
		db.delete(cameras).where(eq(cameras.vmid, vmid)).run();
		return json({ success: true, vmid });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: 500 });
	}
};
