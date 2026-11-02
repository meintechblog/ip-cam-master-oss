import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { createCameraContainer, configureGo2rtc, configureOnvif, getNextVmid, verifyStream } from '$lib/server/services/onboarding';
import { addBambuSubscriber } from '$lib/server/services/bambu-mqtt';

export const POST: RequestHandler = async ({ request }) => {
	const { cameraId } = await request.json();
	if (!cameraId) return json({ success: false, error: 'cameraId required' }, { status: 400 });

	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;
	if (!camera) return json({ success: false, error: 'Camera not found' }, { status: 404 });
	if (camera.cameraType !== 'bambu')
		return json({ success: false, error: 'Not a Bambu camera' }, { status: 400 });

	try {
		// 1. Allocate a real VMID if still on the sentinel 0
		if (!camera.vmid || camera.vmid === 0) {
			const vmid = await getNextVmid();
			db.update(cameras)
				.set({ vmid, updatedAt: new Date().toISOString() })
				.where(eq(cameras.id, cameraId))
				.run();
			camera.vmid = vmid;
		}

		// 2. Create + start LXC, wait for DHCP, update container_ip
		const { vmid, containerIp, fromTemplate } = await createCameraContainer(cameraId);

		// 3. Deploy go2rtc config (rtspx:// passthrough) and start service
		await configureGo2rtc(cameraId, fromTemplate);

		// 4. Deploy ONVIF server so UniFi Protect can auto-discover + adopt
		await configureOnvif(cameraId, fromTemplate);

		// 5. Verify go2rtc /api/streams reports the Bambu stream live
		const health = await verifyStream(cameraId);
		if (!health.success) {
			return json({
				success: false,
				error: `go2rtc started but stream not healthy`,
				vmid,
				containerIp,
				streamInfo: health.streamInfo
			}, { status: 502 });
		}

		// Start MQTT subscriber for Adaptive Stream Mode (Phase 14).
		// Fire-and-forget — failure here does not block onboarding.
		addBambuSubscriber(cameraId).catch((err) =>
			console.error(`[provision] bambu-mqtt subscriber failed for cam=${cameraId}:`, err)
		);

		return json({ success: true, vmid, containerIp, streamName: camera.streamName, rtspUrl: health.rtspUrl });
	} catch (err) {
		return json({
			success: false,
			error: err instanceof Error ? err.message : String(err)
		}, { status: 500 });
	}
};
