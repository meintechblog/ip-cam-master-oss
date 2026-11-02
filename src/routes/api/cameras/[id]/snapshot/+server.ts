import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/services/crypto';
import { request as httpRequest } from 'node:http';

const JPEG_HEADERS = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache, no-store' };

function isJpeg(buf: Buffer): boolean {
	return buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Fetch a JPEG frame from go2rtc's built-in frame API.
 * Fast (~50ms) when the stream is warm, but can hang (>10s) on Mobotix
 * VAAPI transcode streams when no active consumer keeps the pipeline hot.
 */
async function fetchGo2rtcFrame(containerIp: string, streamName: string): Promise<Buffer | null> {
	try {
		const frameUrl = `http://${containerIp}:1984/api/frame.jpeg?src=${streamName}`;
		const res = await fetch(frameUrl, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		return isJpeg(buf) ? buf : null;
	} catch {
		return null;
	}
}

/**
 * Direct HTTP fetch with Basic auth — for native ONVIF cameras and as
 * fallback when go2rtc frame API hangs on Mobotix VAAPI streams.
 */
function httpGetBuffer(url: string, authHeader: string, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
	return new Promise((resolve) => {
		const req = httpRequest(url, {
			method: 'GET',
			headers: { Authorization: authHeader, 'User-Agent': 'ip-cam-master/1', Connection: 'close' },
			agent: false
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
			res.on('error', () => resolve({ status: 0, body: Buffer.alloc(0) }));
		});
		req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0) }));
		req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: Buffer.alloc(0) }); });
		req.end();
	});
}

/**
 * Direct snapshot from Mobotix camera via /record/current.jpg (Basic auth).
 */
async function fetchMobotixDirect(cameraIp: string, username: string, password: string): Promise<Buffer | null> {
	const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	const { status, body } = await httpGetBuffer(`http://${cameraIp}/record/current.jpg`, authHeader, 3000);
	return (status === 200 && isJpeg(body)) ? body : null;
}

export const GET: RequestHandler = async ({ params }) => {
	const cameraId = parseInt(params.id);
	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;

	if (!camera) {
		return new Response('Camera not found', { status: 404 });
	}

	try {
		// Bambu without container (pending Phase 12 provisioning)
		if (camera.cameraType === 'bambu' && !camera.containerIp) {
			return new Response(null, { status: 204 });
		}

		// Primary: go2rtc frame API (fast when stream is warm)
		if (camera.containerIp) {
			const frame = await fetchGo2rtcFrame(camera.containerIp, camera.streamName);
			if (frame) {
				return new Response(new Uint8Array(frame), { headers: JPEG_HEADERS });
			}
		}

		// Fallback for Mobotix: direct snapshot from camera (bypasses go2rtc hang)
		if (camera.cameraType === 'mobotix' || camera.cameraType === 'mobotix-onvif') {
			const password = decrypt(camera.password);
			const directFrame = await fetchMobotixDirect(camera.ip, camera.username, password);
			if (directFrame) {
				return new Response(new Uint8Array(directFrame), { headers: JPEG_HEADERS });
			}
		}

		// Fallback for native ONVIF (no container)
		if (!camera.containerIp && (camera.cameraType === 'mobotix-onvif' || camera.cameraType === 'onvif')) {
			const password = decrypt(camera.password);
			const authHeader = 'Basic ' + Buffer.from(`${camera.username}:${password}`).toString('base64');
			const { status, body } = await httpGetBuffer(`http://${camera.ip}/record/current.jpg`, authHeader, 3000);
			if (status === 200 && isJpeg(body)) {
				return new Response(new Uint8Array(body), { headers: JPEG_HEADERS });
			}
		}

		return new Response('Snapshot unavailable', { status: 502 });
	} catch {
		return new Response('Snapshot timeout', { status: 504 });
	}
};
