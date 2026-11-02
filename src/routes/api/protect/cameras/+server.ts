import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProtectStatus } from '$lib/server/services/protect';

export const GET: RequestHandler = async () => {
	try {
		const status = await getProtectStatus();

		// Serialize Map to array for JSON transport
		const cameras: Array<{ cameraId: number } & Record<string, unknown>> = [];
		for (const [cameraId, match] of status.cameras.entries()) {
			cameras.push({ cameraId, ...match });
		}

		return json({
			connected: status.connected,
			adoptedCount: status.adoptedCount,
			connectedCount: status.connectedCount,
			totalProtectCameras: status.totalProtectCameras,
			cameras
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ connected: false, error: message }, { status: 500 });
	}
};
