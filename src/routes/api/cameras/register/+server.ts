import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/services/crypto';
import { eq } from 'drizzle-orm';

/**
 * Register a native ONVIF camera (no container needed).
 * Just saves to DB for monitoring/dashboard display.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { name, ip, username, password, cameraType } = await request.json();

	if (!name || !ip || !username || !password) {
		return json({ success: false, error: 'Name, IP, Username und Passwort erforderlich' }, { status: 400 });
	}

	try {
		const encryptedPassword = encrypt(password);

		db.insert(cameras)
			.values({
				vmid: 0, // No container
				name,
				ip,
				username,
				password: encryptedPassword,
				cameraType: cameraType || 'mobotix-onvif',
				streamPath: '',
				width: 0,
				height: 0,
				fps: 0,
				bitrate: 0,
				streamName: '',
				containerIp: null,
				status: 'native-onvif'
			})
			.run();

		const inserted = db.select({ id: cameras.id }).from(cameras).where(eq(cameras.ip, ip)).get();
		return json({ success: true, cameraId: inserted?.id ?? 0 });
	} catch (err) {
		return json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
};
