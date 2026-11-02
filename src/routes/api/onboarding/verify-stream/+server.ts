import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyStream } from '$lib/server/services/onboarding';

export const POST: RequestHandler = async ({ request }) => {
	const { cameraId } = await request.json();
	if (!cameraId) {
		return json({ success: false, error: 'cameraId erforderlich' }, { status: 400 });
	}
	try {
		const result = await verifyStream(cameraId);
		return json(result);
	} catch (err) {
		return json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
};
