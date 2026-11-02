// v1.3 Phase 19 — orchestration: discover() + loadCatalog().
//
// Single-transaction upsert over `cameras` (source='external') and
// `protect_stream_catalog`, fed by the typed bootstrap from protect-bridge.ts.
//
// Boundaries:
// - Idempotent on repeat calls (UPSERT-by-MAC for cameras; delete-then-insert
//   for catalog rows — catalog is cache, not source of truth).
// - MAC NOT NULL invariant (L-1) enforced inside the transaction; an empty
//   normalised MAC throws and rolls back the whole batch (no partial state).
// - On `fetchBootstrap()` failure: cache untouched, tagged Result returned.
// - This module does NOT schedule itself. Callers (the API endpoint and,
//   from P21, the reconciler tick) drive cadence.
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db/client';
import { cameras, protectStreamCatalog } from '$lib/server/db/schema';
import {
	classifyKind,
	deriveManufacturerHint,
	fetchBootstrap,
	normalizeMac,
	protectStreamUrl
} from '$lib/server/services/protect-bridge';
import { getSettings } from '$lib/server/services/settings';

export type DiscoverResult =
	| {
			ok: true;
			insertedCams: number;
			updatedCams: number;
			insertedChannels: number;
	  }
	| {
			ok: false;
			reason: 'controller_unreachable' | 'auth_failed' | 'unknown';
			error: Error;
	  };

export async function discover(): Promise<DiscoverResult> {
	const result = await fetchBootstrap();
	if (!result.ok) {
		return { ok: false, reason: result.reason, error: result.error };
	}

	// Resolve the Protect-controller host ONCE before the catalog upsert.
	// UniFi Protect cams (UVC) do not self-host RTSPS — every Share-Livestream
	// URL goes through the controller's :7441 endpoint. Earlier code passed
	// `cam.host` here, which is the camera's own LAN IP; UVC cams reject
	// :7441 with Connection refused, so reconcile produced URLs that ffmpeg
	// could not open. Use unifi_host setting instead — same value the
	// fetchBootstrap() lib client uses to talk to Protect itself.
	const settings = await getSettings('unifi_');
	const controllerHost =
		typeof settings.unifi_host === 'string' && settings.unifi_host.length > 0
			? settings.unifi_host
			: null;

	let insertedCams = 0;
	let updatedCams = 0;
	let insertedChannels = 0;

	try {
		// Wrap the entire batch — any throw rolls back. better-sqlite3 transactions
		// are synchronous; we don't await inside the closure.
		const runUpsert = sqlite.transaction(() => {
			for (const cam of result.cameras) {
				const mac = normalizeMac(cam.mac ?? '');
				if (mac === '') {
					throw new Error(
						`Refusing to upsert external camera with empty mac (id=${cam.id ?? 'unknown'})`
					);
				}

				const kind = classifyKind(cam);
				const manufacturer = deriveManufacturerHint(cam, kind);
				const status = cam.isConnected ? 'connected' : 'disconnected';
				const camName = cam.name ?? cam.displayName ?? `external_${mac}`;

				// UPSERT camera by (source='external', mac). The synchronous Drizzle
				// query API returns the affected row when paired with .returning().
				const existing = db
					.select({ id: cameras.id })
					.from(cameras)
					.where(eq(cameras.mac, mac))
					.all()
					.find((r) => r.id !== undefined);

				let camId: number;
				if (existing) {
					db.update(cameras)
						.set({
							source: 'external',
							externalId: cam.id,
							name: camName,
							ip: cam.host,
							modelName: cam.marketName,
							manufacturer,
							kind,
							status,
							updatedAt: new Date().toISOString()
						})
						.where(eq(cameras.id, existing.id))
						.run();
					camId = existing.id;
					updatedCams += 1;
				} else {
					// Sentinels for legacy NOT-NULL columns that managed-cam code
					// reads. External-cam read paths filter on source='external' and
					// never touch these fields.
					const inserted = db
						.insert(cameras)
						.values({
							source: 'external',
							mac,
							externalId: cam.id,
							hubBridgeId: null,
							name: camName,
							ip: cam.host,
							vmid: 0, // external cams have no LXC
							username: '',
							password: '',
							cameraType: 'mobotix', // sentinel — never read for source='external'
							streamName: `external_${mac}`,
							model: null, // Phase 18 Bambu SSDP code — null for Protect cams
							modelName: cam.marketName,
							manufacturer,
							kind,
							status
						})
						.returning({ id: cameras.id })
						.all();
					camId = inserted[0].id;
					insertedCams += 1;
				}

				// Catalog rows: delete-then-insert. Cleaner than diffing channels;
				// catalog is a cache so the rebuild cost is irrelevant in practice.
				db.delete(protectStreamCatalog)
					.where(eq(protectStreamCatalog.cameraId, camId))
					.run();

				for (const ch of cam.channels.filter((c) => c.enabled)) {
					db.insert(protectStreamCatalog)
						.values({
							cameraId: camId,
							quality: ch.name,
							codec: cam.videoCodec,
							width: ch.width,
							height: ch.height,
							fps: ch.fps,
							bitrate: ch.bitrate,
							rtspUrl:
								ch.isRtspEnabled && ch.rtspAlias && controllerHost
									? protectStreamUrl(controllerHost, ch.rtspAlias)
									: null,
							shareEnabled: ch.isRtspEnabled
						})
						.run();
					insertedChannels += 1;
				}
			}
		});

		runUpsert();
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		return { ok: false, reason: 'unknown', error: e };
	}

	return { ok: true, insertedCams, updatedCams, insertedChannels };
}

export async function loadCatalog(): Promise<{
	cams: Array<typeof cameras.$inferSelect>;
	catalogByCamId: Record<number, Array<typeof protectStreamCatalog.$inferSelect>>;
	lastDiscoveredAt: number | null;
}> {
	const cams = db.select().from(cameras).where(eq(cameras.source, 'external')).all();
	const catalog = db.select().from(protectStreamCatalog).all();

	const catalogByCamId: Record<number, Array<typeof protectStreamCatalog.$inferSelect>> = {};
	for (const row of catalog) {
		if (!catalogByCamId[row.cameraId]) catalogByCamId[row.cameraId] = [];
		catalogByCamId[row.cameraId].push(row);
	}

	const lastDiscoveredAt =
		catalog.length > 0
			? Math.max(...catalog.map((r) => Date.parse(r.cachedAt)).filter((n) => !Number.isNaN(n)))
			: null;

	return { cams, catalogByCamId, lastDiscoveredAt };
}
