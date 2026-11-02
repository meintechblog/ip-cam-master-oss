import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getBambuState } from '$lib/server/services/bambu-mqtt';

export const GET: RequestHandler = async ({ params }) => {
	const id = parseInt(params.id);
	const cam = db.select().from(cameras).where(eq(cameras.id, id)).get() as any;
	if (!cam || cam.cameraType !== 'bambu') {
		return json({ error: 'Not a Bambu camera' }, { status: 404 });
	}
	const state = getBambuState(id);
	return json({
		...state,
		streamMode: cam.streamMode ?? 'adaptive'
	});
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = parseInt(params.id);
	const { streamMode } = await request.json();
	if (!['adaptive', 'always_live', 'always_snapshot'].includes(streamMode)) {
		return json({ error: 'invalid streamMode' }, { status: 400 });
	}
	const cam = db.select().from(cameras).where(eq(cameras.id, id)).get() as any;
	if (!cam || cam.cameraType !== 'bambu') {
		return json({ error: 'Not a Bambu camera' }, { status: 404 });
	}
	db.update(cameras)
		.set({ streamMode, updatedAt: new Date().toISOString() })
		.where(eq(cameras.id, id))
		.run();
	return json({ success: true, streamMode });
};
