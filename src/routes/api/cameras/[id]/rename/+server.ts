import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { connectToProxmox } from '$lib/server/services/ssh';

export const PUT: RequestHandler = async ({ params, request }) => {
	const cameraId = parseInt(params.id);
	const { name } = await request.json();

	if (!name) return json({ success: false, error: 'Name erforderlich' }, { status: 400 });

	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;
	if (!camera) return json({ success: false, error: 'Kamera nicht gefunden' }, { status: 404 });

	// Update DB
	db.update(cameras)
		.set({ name, updatedAt: new Date().toISOString() })
		.where(eq(cameras.id, cameraId))
		.run();

	// Update LXC hostname if container exists
	if (camera.vmid && camera.vmid > 0) {
		try {
			const hostname = `cam-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
			const ssh = await connectToProxmox();
			await ssh.execCommand(`pct set ${camera.vmid} -hostname ${hostname}`);
			ssh.dispose();
		} catch { /* LXC rename failed — not critical */ }
	}

	return json({ success: true });
};
