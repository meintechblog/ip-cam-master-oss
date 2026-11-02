import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchRawProtectLogs } from '$lib/server/services/udm-logs';

export const GET: RequestHandler = async ({ url }) => {
	const linesParam = url.searchParams.get('lines');
	let lines = linesParam ? parseInt(linesParam, 10) : 100;

	// Clamp to max 500
	if (lines > 500) lines = 500;
	if (lines < 1) lines = 1;

	try {
		const logs = await fetchRawProtectLogs(lines);
		const actualLines = logs.split('\n').filter((l) => l.trim()).length;
		return json({ logs, lines: actualLines });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: message, logs: '' }, { status: 500 });
	}
};
