import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '$lib/server/services/crypto';
import { BAMBU_ADOPTION_USERNAME } from '$lib/server/services/onboarding';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Return the credentials used for UniFi Protect adoption.
 * Mobotix/Loxone: the camera's HTTP login.
 * Bambu: serial as username, access code as password.
 * Also indicates whether RTSP auth is currently enforced on go2rtc.
 *
 * Only called from the session-authenticated detail card; never cached.
 */
export const GET: RequestHandler = async ({ params }) => {
	const cameraId = parseInt(params.id);
	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get();
	if (!camera) {
		return json({ error: 'Kamera nicht gefunden' }, { status: 404 });
	}

	let username = '';
	let password = '';
	try {
		if (camera.cameraType === 'bambu') {
			// Short shared username for the Protect adoption dialog — keeps the
			// access code as the actual secret. See BAMBU_ADOPTION_USERNAME.
			username = BAMBU_ADOPTION_USERNAME;
			password = camera.accessCode ? decrypt(camera.accessCode) : '';
		} else {
			username = camera.username;
			password = camera.password ? decrypt(camera.password) : '';
		}
	} catch (err) {
		return json({ error: `Entschlüsselung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
	}

	return json({
		username,
		password,
		rtspAuthEnabled: Boolean(camera.rtspAuthEnabled),
		cameraType: camera.cameraType
	});
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const cameraId = parseInt(params.id);
	const { username, password, test } = await request.json();

	if (!username || !password) {
		return json({ success: false, error: 'Benutzername und Passwort erforderlich' }, { status: 400 });
	}

	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;
	if (!camera) {
		return json({ success: false, error: 'Kamera nicht gefunden' }, { status: 404 });
	}

	// Test credentials if requested
	if (test) {
		const endpoint = camera.camera_type === 'loxone' ? '/mjpg/video.mjpg' : '/record/current.jpg';
		const isMjpeg = camera.camera_type === 'loxone';
		const connectTimeout = isMjpeg ? 5 : 3;
		const maxTime = isMjpeg ? 10 : 3;

		try {
			let stdout = '';
			try {
				const result = await execAsync(
					`curl -s --basic -u "${username}:${password}" "http://${camera.ip}${endpoint}" --connect-timeout ${connectTimeout} --max-time ${maxTime} -o /dev/null -w "%{http_code}"`,
					{ timeout: (maxTime + 5) * 1000, encoding: 'utf-8' }
				);
				stdout = result.stdout;
			} catch (e: unknown) {
				stdout = (e as any)?.stdout || '';
			}
			const code = stdout.trim();
			if (code !== '200' && code !== '206') {
				return json({ success: false, error: `Zugangsdaten ungueltig (HTTP ${code || 'timeout'})` });
			}
		} catch {
			return json({ success: false, error: 'Verbindungstest fehlgeschlagen' });
		}
	}

	// Save encrypted credentials
	db.update(cameras)
		.set({
			username,
			password: encrypt(password),
			updatedAt: new Date().toISOString()
		})
		.where(eq(cameras.id, cameraId))
		.run();

	return json({ success: true });
};
