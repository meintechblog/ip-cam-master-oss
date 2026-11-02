import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { deleteContainer } from '$lib/server/services/proxmox';
import { connectToProxmox, executeOnContainer } from '$lib/server/services/ssh';

export const POST: RequestHandler = async ({ params }) => {
	const cameraId = parseInt(params.id);
	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;

	if (!camera) return json({ success: false, error: 'Kamera nicht gefunden' }, { status: 404 });

	// Delete LXC container if exists
	if (camera.vmid && camera.vmid > 0 && camera.status !== 'native-onvif') {
		try {
			// Stop ONVIF + go2rtc services first so WS-Discovery stops announcing
			// (prevents "ghost camera" in UniFi Protect after deletion)
			const ssh = await connectToProxmox();
			try {
				await executeOnContainer(ssh, camera.vmid, 'systemctl stop onvif-server go2rtc 2>/dev/null || true');
			} catch { /* container might not be running */ }
			ssh.dispose();
		} catch { /* SSH might not be available */ }

		try {
			await deleteContainer(camera.vmid);
		} catch {
			// Container might already be deleted manually — continue
		}
	}

	// Always remove DB entry
	db.delete(cameras).where(eq(cameras.id, cameraId)).run();

	return json({ success: true });
};
