import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDetectionService } from '$lib/server/services/detection-service';

// Read-only liveness/status surface for the lean detection stack (C5).
// Pure observation: it reads C1's FSM state + the C2-fed recent-event buffer off
// the process-wide DetectionService. It does NOT open the live connection (that is
// an explicit start() concern owned by whoever boots the stack).
//
// GRACEFUL-WITH-NO-CREDS CONTRACT: with no UniFi creds configured, the connection
// FSM defaults to 'disconnected' and the buffer is empty — this route returns 200
// with { connectionState: 'disconnected', recent: [] } and NEVER throws.
export const GET: RequestHandler = async () => {
	try {
		const service = getDetectionService();
		// Arm the C1⇄C2 observers so the buffer fills once the stack is started.
		// wire() is idempotent and side-effect-free w.r.t. the network (no ws open).
		service.wire();
		return json(service.status());
	} catch {
		// Defense-in-depth: even a wiring/observation error must degrade to a
		// well-formed disconnected payload rather than a 500 — a status surface that
		// can throw is a worse liveness signal than one that reports "disconnected".
		return json({
			connectionState: 'disconnected',
			started: false,
			lastEventAt: null,
			recent: []
		});
	}
};
