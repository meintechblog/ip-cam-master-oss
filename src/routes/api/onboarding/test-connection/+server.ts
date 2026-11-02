import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { testMobotixConnection } from '$lib/server/services/onboarding';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const POST: RequestHandler = async ({ request }) => {
	const { ip, username, password, cameraType } = await request.json();
	if (!ip || !username || !password) {
		return json({ success: false, error: 'IP, Username und Passwort erforderlich' }, { status: 400 });
	}

	try {
		if (cameraType === 'loxone') {
			// Loxone Intercom: test HTTP MJPEG stream (stays open — never completes)
			// Use --connect-timeout for fast fail on unreachable hosts,
			// and longer --max-time to allow slow Intercoms to return HTTP headers.
			// curl exits 28 on timeout but still writes %{http_code} to stdout.
			let code = '000';
			try {
				const { stdout } = await execAsync(
					`curl -s --basic -u "${username}:${password}" "http://${ip}/mjpg/video.mjpg" --connect-timeout 5 --max-time 10 -o /dev/null -w "%{http_code}"`,
					{ timeout: 15000, encoding: 'utf-8' }
				);
				code = stdout.trim();
			} catch (e: unknown) {
				code = (e as any)?.stdout?.trim() || '000';
			}
			if (code === '200') {
				return json({
					success: true,
					resolution: '1280x720',
					fps: 20,
					streamPath: '/mjpg/video.mjpg'
				});
			} else if (code === '401') {
				return json({
					success: false,
					error: 'Authentifizierung fehlgeschlagen. Mögliche Ursachen: (1) Passwort falsch, oder (2) Intercom ist bereits mit einem anderen System verbunden (Loxone Miniserver, anderer Rekorder) — die Intercom erlaubt nur eine aktive Video-Verbindung gleichzeitig. Trenne die bestehende Verbindung und probiere es erneut.'
				});
			}
			return json({ success: false, error: `Intercom nicht erreichbar (HTTP ${code})` });
		}

		// Mobotix: test via RTSP
		const result = await testMobotixConnection(ip, username, password);
		return json(result);
	} catch (err) {
		return json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
};
