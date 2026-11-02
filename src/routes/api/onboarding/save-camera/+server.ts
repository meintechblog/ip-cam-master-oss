import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { saveCameraRecord } from '$lib/server/services/onboarding';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const POST: RequestHandler = async ({ request }) => {
	const { name, ip, username, password, width, height, fps, bitrate, vmid, cameraType } = await request.json();

	if (!name || !ip || !username || !password || !vmid) {
		return json(
			{ success: false, error: 'Name, IP, Username, Passwort und VMID erforderlich' },
			{ status: 400 }
		);
	}

	// Check for existing camera with same IP
	const existing = db.select().from(cameras).where(eq(cameras.ip, ip)).get() as any;
	if (existing) {
		return json({ success: true, cameraId: existing.id });
	}

	try {
		const cameraId = await saveCameraRecord({
			name,
			ip,
			username,
			password,
			cameraType: cameraType || 'mobotix',
			streamPath: cameraType === 'loxone' ? '/mjpg/video.mjpg' : '/stream0/mobotix.mjpeg',
			width: width || 1280,
			height: height || 720,
			fps: fps || 20,
			bitrate: bitrate || 2000,
			vmid
		});

		return json({ success: true, cameraId });
	} catch (err) {
		return json(
			{ success: false, error: err instanceof Error ? err.message : String(err) },
			{ status: 500 }
		);
	}
};
