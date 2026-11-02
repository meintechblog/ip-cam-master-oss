// Live snapshot proxy for the /live view, keyed by PROTECT camera id (the id a
// MinimalEvent carries). Pulls a single JPEG from Protect via the lib's
// getSnapshot (local LAN call). Local-first: the image is served only to the
// LAN-bound UI — the design keeps this app off any external port precisely so
// snapshots/streams never leave the LAN. No frame is ever forwarded to MQTT.
import type { RequestHandler } from './$types';
import { getProtectClient } from '$lib/server/services/protect-bridge';

const JPEG_HEADERS = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export const GET: RequestHandler = async ({ params }) => {
	const id = params.id;
	if (!id) return new Response('missing id', { status: 400 });
	try {
		const client = await getProtectClient();
		if (!client.bootstrap) await client.getBootstrap();
		const cam = client.bootstrap?.cameras?.find((c) => c.id === id);
		if (!cam) return new Response('camera not found', { status: 404 });
		const snap = await client.getSnapshot(cam);
		if (!snap || snap.length < 100) return new Response('snapshot unavailable', { status: 502 });
		return new Response(new Uint8Array(snap), { headers: JPEG_HEADERS });
	} catch {
		return new Response('snapshot error', { status: 502 });
	}
};
