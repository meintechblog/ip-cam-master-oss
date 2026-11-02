import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEvents } from '$lib/server/services/events';
import { db } from '$lib/server/db/client';
import { events } from '$lib/server/db/schema';
import type { EventSeverity, EventType } from '$lib/types';

export const GET: RequestHandler = async ({ url }) => {
	const cameraIdParam = url.searchParams.get('cameraId');
	const severity = url.searchParams.get('severity') as EventSeverity | null;
	const eventType = url.searchParams.get('eventType') as EventType | null;
	const since = url.searchParams.get('since');
	const until = url.searchParams.get('until');
	const limitParam = url.searchParams.get('limit');
	const offsetParam = url.searchParams.get('offset');

	const filters: Parameters<typeof getEvents>[0] = {};

	if (cameraIdParam) filters.cameraId = parseInt(cameraIdParam, 10);
	if (severity) filters.severity = severity;
	if (eventType) filters.eventType = eventType;
	if (since) filters.since = since;
	if (until) filters.until = until;
	filters.limit = limitParam ? parseInt(limitParam, 10) : 50;
	filters.offset = offsetParam ? parseInt(offsetParam, 10) : 0;

	try {
		const result = getEvents(filters);
		return json({ events: result.events, total: result.total });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ events: [], total: 0, error: message }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async () => {
	try {
		db.delete(events).run();
		return json({ success: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ success: false, error: message }, { status: 500 });
	}
};
