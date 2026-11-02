import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJournal, type Severity } from '$lib/server/services/journal';

const VALID_SEVERITY = new Set<Severity>(['error', 'warning', 'info', 'all']);

export const GET: RequestHandler = async ({ url }) => {
	const linesParam = Number(url.searchParams.get('lines') ?? '200');
	const severityRaw = url.searchParams.get('severity') ?? 'all';
	const severity: Severity = VALID_SEVERITY.has(severityRaw as Severity)
		? (severityRaw as Severity)
		: 'all';
	try {
		const entries = await readJournal(linesParam, severity);
		return json({ entries });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Unknown error', entries: [] },
			{ status: 500 }
		);
	}
};
