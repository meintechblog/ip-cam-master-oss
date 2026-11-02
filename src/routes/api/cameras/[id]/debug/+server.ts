// Quick-task 260530-fff — GET /api/cameras/[id]/debug
// Read-only multi-layer health of one camera. Returns 200 typed JSON for an
// existing cam, 404 for a missing one. NO writes, NO SSH, NO deploy.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { buildCameraDebugHealth } from '$lib/server/services/camera-debug-health';

export const GET: RequestHandler = async ({ params }) => {
	// T-fff-01: parseInt + Drizzle eq — non-numeric/missing id misses the row → 404.
	const cameraId = parseInt(params.id);
	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get();

	if (!camera) {
		return json({ error: 'Camera not found' }, { status: 404 });
	}

	return json(await buildCameraDebugHealth(camera));
};
