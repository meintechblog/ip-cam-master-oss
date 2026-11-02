// v1.3 Phase 22 Plan 02 — GET /api/protect-hub/drift (cached drift indicator).
//
// P22 stub per RESEARCH §Pitfall #10: drift detection (5-min scheduler tick +
// on-demand SSH probe of the deployed YAML mtime/hash on the bridge LXC) ships
// in P23. P22 surfaces only the response shape so Plan 05's HubStatusPanel can
// conditionally render the drift block once P23 lands the column write.
//
// Until then this always returns `{ driftDetected: false, checkedAt: null }`.
// Treat as a feature flag: HubStatusPanel reads this and — for P22 — never
// shows the drift warning. P23 will replace the body with a read of
// protect_hub_bridges.driftDetected + .driftCheckedAt (columns to be added).
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({ ok: true, driftDetected: false, checkedAt: null });
};
