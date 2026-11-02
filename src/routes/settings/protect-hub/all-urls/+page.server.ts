// v1.3 Phase 22 Plan 05 — Hub-Adressen Übersicht (HUB-UI-07).
//
// Bulk-copy view for users provisioning Loxone or Frigate at scale. Renders
// every active output URL grouped by output type (Loxone-MJPEG first,
// Frigate-RTSP second). Loader joins camera_outputs INNER JOIN cameras
// WHERE camera_outputs.enabled=true AND cameras.source='external' (per
// RESEARCH §Open Question 6 — read directly here, do NOT add a separate
// /api/protect-hub/all-outputs endpoint).
//
// Empty page state when settings.protect_hub_enabled !== 'true': we return
// `{ hubEnabled: false, outputs: [], bridgeIp: null }` and let the page
// render the "Hub ist nicht aktiv" copy.
import type { PageServerLoad } from './$types';
import { eq, and } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { cameraOutputs, cameras } from '$lib/server/db/schema';
import { getSetting } from '$lib/server/services/settings';
import { getBridgeStatus } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';
import { deriveSlug, deriveStreamUrl, type OutputType } from '$lib/protect-hub/slug';

export type AllUrlsRow = {
	camId: number;
	camName: string;
	mac: string;
	outputType: OutputType;
	slug: string;
	url: string;
};

export const load: PageServerLoad = async () => {
	const hubEnabled = (await getSetting('protect_hub_enabled')) === 'true';
	if (!hubEnabled) {
		return { hubEnabled: false, outputs: [] as AllUrlsRow[], bridgeIp: null as string | null };
	}

	const bridge = getBridgeStatus();
	const bridgeIp = bridge?.containerIp ?? null;

	const rows = db
		.select({
			camId: cameras.id,
			camName: cameras.name,
			mac: cameras.mac,
			outputType: cameraOutputs.outputType
		})
		.from(cameraOutputs)
		.innerJoin(cameras, eq(cameraOutputs.cameraId, cameras.id))
		.where(and(eq(cameraOutputs.enabled, true), eq(cameras.source, 'external')))
		.all();

	const outputs: AllUrlsRow[] = rows
		.filter((r): r is { camId: number; camName: string; mac: string; outputType: string } =>
			Boolean(r.mac) && Boolean(bridgeIp)
		)
		.map((r) => {
			const ot = r.outputType as OutputType;
			return {
				camId: r.camId,
				camName: r.camName,
				mac: r.mac,
				outputType: ot,
				slug: deriveSlug(r.mac, ot),
				url: deriveStreamUrl(bridgeIp as string, r.mac, ot)
			};
		});

	return { hubEnabled: true, outputs, bridgeIp };
};
