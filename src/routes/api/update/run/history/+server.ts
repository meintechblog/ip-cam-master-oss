import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readUpdateRuns } from '$lib/server/services/update-history';

export const GET: RequestHandler = async () => {
	const runs = await readUpdateRuns(5);
	return json(runs);
};
