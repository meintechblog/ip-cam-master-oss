// Camera id→name list for the /live view's camera picker. Sourced from the
// Protect bootstrap (via the pull bridge, NOT the C1 events connection) so the
// LiveView can resolve the bare Protect camera ids that MinimalEvents carry into
// human names, and offer a snapshot target. Names only — no stream/credential
// data crosses this boundary.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchBootstrap } from '$lib/server/services/protect-bridge';

export const GET: RequestHandler = async () => {
	const r = await fetchBootstrap();
	if (!r.ok) {
		return json({ ok: false, reason: r.reason, cameras: [] });
	}
	const cameras = r.cameras
		.map((c) => ({
			id: c.id,
			name: c.name ?? c.id,
			smartDetect: ((c.featureFlags?.smartDetectTypes ?? []) as unknown[]).length > 0
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return json({ ok: true, cameras });
};
