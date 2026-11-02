import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras, streamHealth } from '$lib/server/db/schema';
import type { CamHealthSummary, CamHealthStatus } from '$lib/types';

// Quick-task 260531-2zx — Debug-Platform Tier-1 #4 (cross-cam health ampel).
//
// Read-only GET /api/cameras/health-summary: one CamHealthSummary per managed
// camera, joined in JS (not a Drizzle leftJoin) against the latest stream_health
// snapshot. The stream_health table is bounded (one row per managed stream,
// upserted by the 30s sampler) so loading it whole and joining via a Map is
// cheap and keeps the logic trivially testable.
//
// SECURITY (T-2zx-01): only the 5 non-sensitive fields are returned —
// cameraId, name, status, phantomAdoption, lastProbedAt. NEVER credentials,
// IPs, SSH keys (status-endpoint CR-01 lesson). No writes / SSH / container
// fetches anywhere in this handler (T-2zx-02 read-only).
//
// CamHealthSummary lives in $lib/types so this endpoint and CamHealthStrip.svelte
// share one source of truth for the response contract.
export const GET: RequestHandler = async () => {
	try {
		// 1. Managed cams only — same filter convention as stream-health-sampler.ts.
		const managedCams = db
			.select({ id: cameras.id, name: cameras.name, streamName: cameras.streamName })
			.from(cameras)
			.where(eq(cameras.source, 'managed'))
			.all();

		// 2. All stream_health snapshots (bounded table — one row per managed stream).
		const healthRows = db
			.select({
				streamKey: streamHealth.streamKey,
				status: streamHealth.status,
				phantomAdoption: streamHealth.phantomAdoption,
				lastProbedAt: streamHealth.lastProbedAt
			})
			.from(streamHealth)
			.all();

		// 3. Join in JS: stream_health.stream_key === cameras.stream_name.
		const healthByKey = new Map<string, (typeof healthRows)[number]>();
		for (const row of healthRows) {
			healthByKey.set(row.streamKey, row);
		}

		const summary: CamHealthSummary[] = managedCams.map((cam) => {
			const row = healthByKey.get(cam.streamName);
			// Cam without a matching stream_health row → 'unknown' / false / null.
			const status = (row?.status as CamHealthStatus | undefined) ?? 'unknown';
			return {
				cameraId: cam.id,
				name: cam.name,
				status,
				phantomAdoption: row?.phantomAdoption ?? false,
				lastProbedAt: row?.lastProbedAt ?? null
			};
		});

		// 4. Sort by name — consistent with /api/cameras/status.
		summary.sort((a, b) => a.name.localeCompare(b.name));

		return json(summary);
	} catch {
		return json([], { status: 500 });
	}
};
