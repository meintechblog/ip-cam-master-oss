import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/services/crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const POST: RequestHandler = async ({ params }) => {
	const cameraId = parseInt(params.id);
	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;

	if (!camera) {
		return json({ success: false, error: 'Kamera nicht gefunden' }, { status: 404 });
	}

	try {
		const password = decrypt(camera.password);

		if (camera.camera_type === 'loxone') {
			// Loxone Intercom reboot via /dev/sys/reboot
			const { stdout } = await execAsync(
				`curl -s --basic -u "${camera.username}:${password}" "http://${camera.ip}/dev/sys/reboot" --max-time 5`,
				{ timeout: 8000, encoding: 'utf-8' }
			);

			if (stdout.includes('reboot')) {
				return json({ success: true });
			}
			return json({ success: false, error: 'Intercom-Neustart fehlgeschlagen' });
		}

		// Mobotix reboot via HTTP API
		const { stdout } = await execAsync(
			`curl -s --basic -u "${camera.username}:${password}" "http://${camera.ip}/admin/rcontrol?action=reboot" --max-time 5`,
			{ timeout: 8000, encoding: 'utf-8' }
		);

		if (stdout.includes('OK') || stdout.includes('Reboot')) {
			return json({ success: true });
		}

		// Fallback endpoint
		const { stdout: stdout2 } = await execAsync(
			`curl -s --basic -u "${camera.username}:${password}" "http://${camera.ip}/control/rcontrol?action=reboot" --max-time 5 -o /dev/null -w "%{http_code}"`,
			{ timeout: 8000, encoding: 'utf-8' }
		);

		if (stdout2.trim() === '200') {
			return json({ success: true });
		}

		return json({ success: false, error: 'Kamera-Neustart fehlgeschlagen' });
	} catch {
		return json({ success: false, error: 'Verbindung zur Kamera fehlgeschlagen' }, { status: 500 });
	}
};
