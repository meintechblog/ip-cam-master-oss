// v1.3 Phase 21 Plan 05 — PUT /api/cameras/[id]/outputs.
//
// Replace-strategy per D-API-02: deletes all camera_outputs rows for the cam,
// then inserts the requested ones. Enforces VAAPI cap (soft 10, hard 12,
// raised 2026-05-16 from 4/6 after the actual GPU was identified — Intel
// Core Ultra 7 255H Arrow Lake-P) per D-CAP-01/02 + L-26 — Frigate-RTSP
// outputs are NOT counted (passthrough is zero VAAPI cost).
//
// Triggers force-reconcile via reconcile.ts (HUB-RCN-02) AFTER the DB write,
// fire-and-forget so the UI gets an immediate 200 (D-API-01 spirit applied
// to the toggle path too).
//
// SELECT order assumed by outputs/server.test.ts mocks:
//   1) cameras (camera lookup)
//   2) count(*) of MJPEG outputs on OTHER cams (cap check)
//   3) protect_hub_bridges (running bridge for reconcile fan-out)
// If you reorder these, update the .mockReturnValueOnce sequence in the test.
//
// Auth: handled by global hooks.server.ts (T-21-04 disposition=accept; LAN-trust).
// T-21-12 mitigation: ALLOWED_OUTPUT_TYPES gate runs BEFORE any DB write.
import { json } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras, cameraOutputs, protectHubBridges } from '$lib/server/db/schema';
import { reconcile } from '$lib/server/orchestration/protect-hub/reconcile';
import { storeEvent } from '$lib/server/services/events';
import type { CameraEvent } from '$lib/types';

// P22-UAT 2026-05-16 — raised from 6 → 12 after user added a 7th cam (G6
// Pro Entry doorbell with shared Medium + Package channels). Original cap
// was set conservatively during P21 planning before the actual GPU was
// known. Live bridge runs on Intel Core Ultra 7 255H (Arrow Lake-P), whose
// Quick Sync media engine handles 12+ simultaneous MJPEG-VAAPI encodes
// at 640x360@10fps trivially (Loxone-MJPEG is the lightest Quick Sync
// workload there is). Re-derive if/when a smaller GPU is targeted.
const VAAPI_HARD_CAP = 12;
const VAAPI_SOFT_CAP = 10;
const ALLOWED_OUTPUT_TYPES = new Set(['loxone-mjpeg', 'frigate-rtsp']);

interface OutputInput {
	outputType?: string;
	enabled?: boolean;
}

export const PUT: RequestHandler = async ({ params, request }) => {
	const camId = Number(params.id);
	if (!Number.isFinite(camId) || !Number.isInteger(camId) || camId <= 0) {
		return json({ ok: false, reason: 'invalid_camera_id' }, { status: 400 });
	}

	let body: { outputs?: OutputInput[] };
	try {
		body = (await request.json()) as { outputs?: OutputInput[] };
	} catch {
		return json({ ok: false, reason: 'invalid_json' }, { status: 400 });
	}
	if (!Array.isArray(body.outputs)) {
		return json({ ok: false, reason: 'outputs_must_be_array' }, { status: 400 });
	}

	// T-21-12 mitigation: enum + type validation BEFORE any DB write.
	for (const out of body.outputs) {
		if (!out.outputType || !ALLOWED_OUTPUT_TYPES.has(out.outputType)) {
			return json(
				{ ok: false, reason: 'unknown_output_type', outputType: out.outputType ?? null },
				{ status: 400 }
			);
		}
		if (typeof out.enabled !== 'boolean') {
			return json({ ok: false, reason: 'enabled_must_be_boolean' }, { status: 400 });
		}
	}

	// SELECT 1: camera lookup
	const camera = db.select().from(cameras).where(eq(cameras.id, camId)).get();
	if (!camera) {
		return json({ ok: false, reason: 'camera_not_found' }, { status: 404 });
	}
	if (camera.source !== 'external') {
		return json({ ok: false, reason: 'not_protect_hub_cam' }, { status: 400 });
	}

	// SELECT 2: count of MJPEG outputs on OTHER cams (cap check). Frigate-RTSP
	// is NOT counted — passthrough is zero VAAPI cost (per L-26 + D-CAP-02).
	const countRow = db
		.select({ n: sql<number>`count(*)` })
		.from(cameraOutputs)
		.where(
			and(
				eq(cameraOutputs.outputType, 'loxone-mjpeg'),
				eq(cameraOutputs.enabled, true),
				sql`${cameraOutputs.cameraId} != ${camId}`
			)
		)
		.get();
	const currentMjpegCount = countRow?.n ?? 0;

	const requestedMjpegCount = body.outputs.filter(
		(o) => o.outputType === 'loxone-mjpeg' && o.enabled === true
	).length;

	const projectedTotal = currentMjpegCount + requestedMjpegCount;

	// D-CAP-02 hard cap: 422 with EXACT German wording (plan-checker verifies prefix).
	if (projectedTotal > VAAPI_HARD_CAP) {
		return json(
			{
				ok: false,
				reason: 'vaapi_hard_cap_exceeded',
				message: `Maximal ${VAAPI_HARD_CAP} gleichzeitige Loxone-MJPEG-Transkodierungen pro Bridge möglich. Aktuell: ${projectedTotal}.`
			},
			{ status: 422 }
		);
	}

	// Replace strategy per D-API-02: drop existing rows for this cam, then insert new ones.
	db.delete(cameraOutputs).where(eq(cameraOutputs.cameraId, camId)).run();
	for (const out of body.outputs) {
		db.insert(cameraOutputs)
			.values({
				cameraId: camId,
				outputType: out.outputType as string,
				enabled: out.enabled as boolean,
				config: '{}'
			})
			.run();
	}

	// D-CAP-01 — soft-cap warning event AFTER successful write. P22 surfaces the UI banner.
	// EventType union in src/lib/types.ts is closed over the legacy v1.0 names
	// (camera_disconnect / camera_reconnect / stream_failed / adoption_changed /
	// aiport_error). 'vaapi_soft_cap_warning' + source='protect_hub' are P21 additions
	// — the events table column is plain text, but the TS union forces the cast.
	// P23 will widen the union when it ships the reconcile-log + cap-warning UI surfaces.
	if (projectedTotal >= VAAPI_SOFT_CAP) {
		storeEvent({
			cameraId: null,
			cameraName: 'Protect Hub',
			eventType: 'vaapi_soft_cap_warning',
			severity: 'info',
			message: `${projectedTotal} von ${VAAPI_HARD_CAP} VAAPI-Transkodierungen aktiv (Soft-Cap ${VAAPI_SOFT_CAP} erreicht).`,
			source: 'protect_hub',
			timestamp: new Date().toISOString()
		} as unknown as Omit<CameraEvent, 'id'>);
	}

	// SELECT 3: running bridge for reconcile fan-out.
	// Fire-and-forget per HUB-RCN-02 — UI gets immediate 200; reconcile.ts
	// internal single-flight serialises bursts (T-21-02 mitigation).
	const bridge = db
		.select()
		.from(protectHubBridges)
		.where(eq(protectHubBridges.status, 'running'))
		.limit(1)
		.get();
	if (bridge) {
		void reconcile(bridge.id, 'output_toggle').catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.error('[PUT /api/cameras/[id]/outputs] background reconcile failed:', msg);
		});
	}
	// If no running bridge: toggle is persisted; the next manual force-reconcile
	// or scheduler 5-min tick (Plan 06) picks it up. We still return 200 so the
	// UI updates optimistically.

	return json({ ok: true, projectedMjpegCount: projectedTotal });
};
