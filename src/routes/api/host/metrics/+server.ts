import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getDiskUsage,
	getMemoryUsage,
	getServiceStatus
} from '$lib/server/services/host-metrics';

export const GET: RequestHandler = async () => {
	try {
		const [disk, memory, service] = await Promise.all([
			getDiskUsage('/'),
			getMemoryUsage(),
			getServiceStatus()
		]);
		return json({ disk, memory, service });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: message }, { status: 500 });
	}
};
