import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { ip, username, password, cameraType } = await request.json();

	if (!ip || !username || !password) {
		return new Response(JSON.stringify({ error: 'IP, username and password required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	try {
		const auth = Buffer.from(`${username}:${password}`).toString('base64');

		if (cameraType === 'loxone') {
			// Loxone Intercom: grab single frame from MJPEG stream via ffmpeg
			// Must use -headers with pre-built Basic Auth (Loxone drops connection on challenge-based auth)
			const { execSync } = await import('node:child_process');
			const authHeader = `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
			const jpegBuffer = execSync(
				`ffmpeg -y -headers "${authHeader}\r\n" -i "http://${ip}/mjpg/video.mjpg" -frames:v 1 -f image2 -q:v 5 pipe:1 2>/dev/null`,
				{ timeout: 10000, maxBuffer: 2 * 1024 * 1024 }
			);
			return new Response(jpegBuffer, {
				headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' }
			});
		}

		// Mobotix: direct JPEG snapshot URL
		const url = `http://${ip}/record/current.jpg`;
		const res = await fetch(url, {
			headers: { Authorization: `Basic ${auth}` },
			signal: AbortSignal.timeout(5000)
		});

		if (!res.ok) {
			return new Response(JSON.stringify({ error: `Camera returned ${res.status}` }), {
				status: 502,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const imageBuffer = await res.arrayBuffer();
		return new Response(imageBuffer, {
			headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' }
		});
	} catch (err) {
		return new Response(
			JSON.stringify({ error: err instanceof Error ? err.message : 'Snapshot failed' }),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};
