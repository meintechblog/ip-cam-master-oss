import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '$lib/server/services/crypto';
import { removeBambuSubscriber, addBambuSubscriber } from '$lib/server/services/bambu-mqtt';

/**
 * PATCH /api/cameras/:id/bambu-credentials
 *
 * Updates the Bambu printer access code, refreshes go2rtc stream source
 * via its HTTP API, and reconnects the MQTT subscriber with new credentials.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const cameraId = parseInt(params.id);
	const { accessCode } = await request.json();

	if (!accessCode || typeof accessCode !== 'string' || accessCode.length < 4) {
		return json({ success: false, error: 'Access Code erforderlich (mind. 4 Zeichen)' }, { status: 400 });
	}

	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;
	if (!camera) {
		return json({ success: false, error: 'Kamera nicht gefunden' }, { status: 404 });
	}
	if (camera.cameraType !== 'bambu') {
		return json({ success: false, error: 'Nur fuer Bambu-Kameras' }, { status: 400 });
	}

	// 1. Save encrypted access code to DB
	db.update(cameras)
		.set({
			accessCode: encrypt(accessCode),
			updatedAt: new Date().toISOString()
		})
		.where(eq(cameras.id, cameraId))
		.run();

	// 2. Update go2rtc stream source dynamically via HTTP API (if container is running)
	if (camera.containerIp) {
		try {
			const sourceUrl = `rtspx://bblp:${accessCode}@${camera.ip}:322/streaming/live/1#video=copy#audio=copy#reconnect_timeout=30`;
			const updateUrl = `http://${camera.containerIp}:1984/api/streams?name=${camera.streamName}&src=${encodeURIComponent(sourceUrl)}`;
			const res = await fetch(updateUrl, { method: 'PUT', signal: AbortSignal.timeout(5000) });
			if (!res.ok) {
				console.error(`[bambu-credentials] go2rtc stream update failed: ${res.status}`);
			}
		} catch (err) {
			console.error('[bambu-credentials] go2rtc stream update error:', err);
			// Non-fatal — go2rtc config on disk will be updated on next redeploy
		}
	}

	// 3. Reconnect MQTT subscriber with new credentials
	removeBambuSubscriber(cameraId);
	try {
		await addBambuSubscriber(cameraId);
	} catch (err) {
		console.error('[bambu-credentials] MQTT reconnect error:', err);
	}

	return json({ success: true });
};
