import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/services/crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// In-memory cache per camera (avoid hammering the camera)
const cache = new Map<number, { data: any; ts: number }>();
const CACHE_TTL = 15000; // 15 seconds

export const GET: RequestHandler = async ({ params }) => {
	const cameraId = parseInt(params.id);

	// Return cached result if fresh
	const cached = cache.get(cameraId);
	if (cached && Date.now() - cached.ts < CACHE_TTL) {
		return json(cached.data);
	}

	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;
	if (!camera) return json({ error: 'Camera not found' }, { status: 404 });

	let liveFps: number | null = null;
	let maxFps: number | null = null;
	let cameraModel: string | null = null;
	let firmwareVersion: string | null = null;
	let codec: string | null = null;

	try {
		const password = decrypt(camera.password);

		// Step 1: Get model + firmware FIRST (before ffprobe hogs the connection)
		try {
			const { stdout: html } = await execAsync(
				`curl -s --basic -u "${camera.username}:${password}" "http://${camera.ip}/admin/version" --max-time 3`,
				{ timeout: 5000, encoding: 'utf-8' }
			);
			const tdMatches = html.match(/<td[^>]*>(.*?)<\/td>/gs) || [];
			const tdTexts = tdMatches.map((td: string) => td.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
			if (tdTexts.length > 0 && tdTexts[0].includes('MOBOTIX')) {
				cameraModel = tdTexts[0];
			}
			const fwEntry = tdTexts.find((t: string) => t.startsWith('MX-V'));
			if (fwEntry) firmwareVersion = fwEntry;
		} catch { /* camera HTTP not reachable */ }

		// Step 2: Live FPS via ffprobe (holds RTSP connection, blocks camera HTTP)
		try {
			const { stdout: probeJson } = await execAsync(
				`timeout 4 ffprobe -v quiet -print_format json -show_entries stream=nb_read_frames -count_frames -read_intervals "%+2" -select_streams v -rtsp_transport tcp "rtsp://${camera.username}:${password}@${camera.ip}:554${camera.streamPath || '/stream0/mobotix.mjpeg'}"`,
				{ timeout: 6000, encoding: 'utf-8' }
			);
			const probeData = JSON.parse(probeJson);
			const frames = parseInt(probeData.streams?.[0]?.nb_read_frames || '0');
			if (frames > 0) liveFps = Math.round(frames / 2);
		} catch { /* ffprobe not available or timeout */ }

		// Configured FPS
		maxFps = camera.fps;
		// ONVIF-capable cameras support H.264, others use MxPEG (MJPEG)
		if (camera.cameraType === 'mobotix-onvif') {
			codec = 'H.264 (ONVIF)';
		} else {
			codec = 'MxPEG (MJPEG)';
		}
	} catch {
		// Decryption failed
	}

	const result = { liveFps, maxFps: maxFps || camera.fps, configuredFps: camera.fps, cameraModel, firmwareVersion, codec };
	cache.set(cameraId, { data: result, ts: Date.now() });
	return json(result);
};
