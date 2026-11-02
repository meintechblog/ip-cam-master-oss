import { json } from '@sveltejs/kit';
import { inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras, cameraOutputs, protectStreamCatalog } from '$lib/server/db/schema';
import { listContainers } from '$lib/server/services/proxmox';
import { getSettings } from '$lib/server/services/settings';
import { decrypt } from '$lib/server/services/crypto';
import { getProtectStatus } from '$lib/server/services/protect';
import { getFlappingCameras } from '$lib/server/services/events';
import { getBambuState } from '$lib/server/services/bambu-mqtt';
import { PRINTER_CAPABILITIES } from '$lib/server/services/bambu-discovery';
import type {
	CameraCardData,
	ProtectCameraMatch,
	CameraSource,
	CameraKind,
	StreamCatalogRow,
	CameraOutputRow
} from '$lib/types';

export const GET: RequestHandler = async () => {
	try {
		const allCameras = db.select().from(cameras).all();
		if (allCameras.length === 0) {
			return json([]);
		}

		// Get container statuses from Proxmox
		let containerMap: Map<number, any> = new Map();
		try {
			const containers = await listContainers();
			containerMap = new Map(containers.map((c) => [c.vmid, c]));
		} catch {
			// Proxmox unreachable
		}

		// v1.3 Phase 22 Plan 02 — batched load of stream catalog + outputs for external cams.
		// Plan 03's ExternalCamCard reads `streamCatalog` (read-only catalog table) and
		// `outputs` (OutputsSubsection initial state) directly from the cam row — keep this
		// here to avoid an extra round-trip from the browser. Managed cams get empty arrays
		// (no leakage; the WHERE filters by id list which excludes managed cams).
		const externalCamIds: number[] = allCameras
			.filter((c: any) => c.source === 'external')
			.map((c: any) => c.id as number);

		const allCatalog = externalCamIds.length
			? db
					.select({
						cameraId: protectStreamCatalog.cameraId,
						quality: protectStreamCatalog.quality,
						codec: protectStreamCatalog.codec,
						width: protectStreamCatalog.width,
						height: protectStreamCatalog.height,
						fps: protectStreamCatalog.fps,
						bitrate: protectStreamCatalog.bitrate
					})
					.from(protectStreamCatalog)
					.where(inArray(protectStreamCatalog.cameraId, externalCamIds))
					.all()
			: [];
		const allOutputs = externalCamIds.length
			? db
					.select({
						cameraId: cameraOutputs.cameraId,
						outputType: cameraOutputs.outputType,
						enabled: cameraOutputs.enabled
					})
					.from(cameraOutputs)
					.where(inArray(cameraOutputs.cameraId, externalCamIds))
					.all()
			: [];

		const catalogByCam = new Map<number, StreamCatalogRow[]>();
		for (const r of allCatalog) {
			const arr = catalogByCam.get(r.cameraId) ?? [];
			arr.push({
				quality: r.quality,
				codec: r.codec,
				width: r.width,
				height: r.height,
				fps: r.fps,
				bitrate: r.bitrate
			});
			catalogByCam.set(r.cameraId, arr);
		}
		const outputsByCam = new Map<number, CameraOutputRow[]>();
		for (const r of allOutputs) {
			const arr = outputsByCam.get(r.cameraId) ?? [];
			arr.push({
				outputType: r.outputType as 'loxone-mjpeg' | 'frigate-rtsp',
				enabled: !!r.enabled
			});
			outputsByCam.set(r.cameraId, arr);
		}

		// Collect live data for each camera in parallel
		const results: CameraCardData[] = await Promise.all(
			allCameras.map(async (cam: any) => {
				const containerData = containerMap.get(cam.vmid);
				const containerStatus = containerData?.status || 'unknown';
				const containerIp = cam.containerIp;
				const lxcCpu = containerData?.cpu ?? null;
				const lxcMemory = containerData?.memory ?? null;
				const lxcMac: string | null = containerData?.mac ?? null;

				let go2rtcRunning = false;
				let onvifRunning = false;
				let streamInfo = null;
				let connectedClients = 0;

				if (containerIp && containerStatus === 'running') {
					// Check go2rtc API
					try {
						const res = await fetch(`http://${containerIp}:1984/api/streams`, {
							signal: AbortSignal.timeout(3000)
						});
						if (res.ok) {
							go2rtcRunning = true;
							const data = await res.json();
							const stream = data[cam.streamName];
							if (stream) {
								const producers = Array.isArray(stream.producers) ? stream.producers.length : 0;
								const consumerList = Array.isArray(stream.consumers) ? stream.consumers : [];
								const consumers = consumerList.length;
								const unifiConnected = consumerList.some(
									(c: any) => c.user_agent?.includes('ui.com') || c.user_agent?.includes('Media Server') || c.user_agent?.includes('GStreamer')
								);
								const unifiStreams = consumerList.filter(
									(c: any) => c.user_agent?.includes('ui.com') || c.user_agent?.includes('Media Server') || c.user_agent?.includes('GStreamer')
								).length;
								// Extract video codec from first video producer, audio from audio producer
							const videoProducer = stream.producers?.find((p: any) =>
								p.medias?.some((m: string) => m.includes('video'))
							);
							const audioProducer = stream.producers?.find((p: any) =>
								p.medias?.some((m: string) => m.includes('audio'))
							);
							const audioCodec = audioProducer?.medias
								?.find((m: string) => m.includes('audio'))
								?.match(/audio,\s*\w+,\s*(.+)/)?.[1] || null;

							streamInfo = {
								active: producers > 0,
								codec: videoProducer?.medias?.find((m: string) => m.includes('video'))?.match(/video,\s*\w+,\s*(.+)/)?.[1] || stream.producers?.[0]?.codec || null,
								audioCodec,
								producers,
								resolution: videoProducer?.resolution || stream.producers?.[0]?.resolution || null
							};
								connectedClients = consumers;
								(streamInfo as any).unifiConnected = unifiConnected;
								(streamInfo as any).unifiStreams = unifiStreams;
							}
						}
					} catch {
						// go2rtc not reachable
					}

					// Check ONVIF server (port 8899)
					try {
						const res = await fetch(`http://${containerIp}:8899`, {
							signal: AbortSignal.timeout(2000)
						});
						onvifRunning = res.status !== 0;
					} catch (err: any) {
						// Connection refused = not running, ECONNRESET/other = running (ONVIF responds oddly to plain HTTP)
						if (err?.cause?.code === 'ECONNRESET' || err?.message?.includes('ECONNRESET')) {
							onvifRunning = true;
						}
					}
				}

				// v1.3 Phase 22 CR-01 fix — only build cameraWebUrl (which embeds the
				// decrypted plaintext camera password) for managed cams. External Protect
				// cams have no valid managed credentials in `cameras` (the catalog upsert
				// stores whatever Protect provides, which may be empty/UDM admin) and the
				// ExternalCamCard never renders this field, so omitting it removes the
				// credential leak from every /api/cameras/status poll. external_archived
				// is also excluded for the same reason.
				let cameraWebUrl: string | null = null;
				if (cam.source !== 'external' && cam.source !== 'external_archived') {
					try {
						const decryptedPass = decrypt(cam.password);
						cameraWebUrl = `http://${cam.username}:${encodeURIComponent(decryptedPass)}@${cam.ip}`;
					} catch {
						cameraWebUrl = `http://${cam.ip}`;
					}
				}

				return {
					id: cam.id,
					vmid: cam.vmid,
					name: cam.name,
					cameraIp: cam.ip,
					cameraType: cam.cameraType || 'mobotix',
					cameraWebUrl,
					containerIp,
					streamName: cam.streamName,
					rtspUrl: containerIp ? `rtsp://${containerIp}:8554/${cam.streamName}` : null,
					status: cam.status,
					rtspAuthEnabled: Boolean(cam.rtspAuthEnabled),
					width: cam.width,
					height: cam.height,
					fps: cam.fps,
					bitrate: cam.bitrate,
					containerStatus,
					go2rtcRunning,
					onvifRunning,
					streamInfo,
					connectedClients,
					snapshotUrl: `/api/cameras/${cam.id}/snapshot`,
					go2rtcWebUrl: containerIp
						? `http://${containerIp}:1984`
						: null,
					cameraModel: null,
					firmwareVersion: null,
					liveFps: null,
					lxcCpu,
					lxcMemory,
					lxcMac,
					printState: cam.cameraType === 'bambu' ? (cam.printState ?? null) : null,
					streamMode: cam.cameraType === 'bambu' ? (cam.streamMode ?? 'adaptive') : null,
					bambuError: cam.cameraType === 'bambu' ? (getBambuState(cam.id).error ?? null) : null,
					bambuMqttConnected: cam.cameraType === 'bambu' ? getBambuState(cam.id).connected : undefined,
					// Phase 18 / BAMBU-A1-11: per-model capability matrix so the
					// dashboard can hide A1-irrelevant H2C fields (chamber temp,
					// full AMS, unsupported xcam features) without hardcoded model
					// branches. Legacy rows with null `model` fall back to H2C
					// capabilities (pre-Phase-18 default).
					capabilities:
						cam.cameraType === 'bambu'
							? (PRINTER_CAPABILITIES[cam.model ?? 'H2C'] ?? PRINTER_CAPABILITIES['H2C'])
							: undefined,
					// v1.3 Phase 22 — Hub-related scalar fields (HUB-UI-01).
					// Defaults guard against legacy rows pre-dating P19; new rows always populate these.
					source: ((cam.source ?? 'managed') as CameraSource),
					kind: ((cam.kind ?? 'unknown') as CameraKind),
					manufacturer: cam.manufacturer ?? null,
					modelName: cam.modelName ?? null,
					externalId: cam.externalId ?? null,
					hubBridgeId: cam.hubBridgeId ?? null,
					// v1.3 Phase 22 Plan 03 (Rule 3 deviation) — surface the cam MAC so
					// ExternalCamCard / ProtectHubGuide / OutputsSubsection can derive the
					// go2rtc slug via deriveSlug(mac, outputType). Plan 02 omitted this when
					// adding the 6 hub fields; without it the slug pipeline is unusable on
					// the client. For external Protect cams this is the Protect-side MAC
					// (lowercase hex, no separators per the catalog upsert convention).
					mac: cam.mac ?? null,
					// v1.3 Phase 22 — Catalog + outputs arrays consumed by Plan 03 ExternalCamCard.
					// Empty for managed cams (lookup miss → []).
					streamCatalog: catalogByCam.get(cam.id) ?? [],
					outputs: outputsByCam.get(cam.id) ?? []
				} satisfies CameraCardData;
			})
		);

		// Build MAC map from live Proxmox data for Protect MAC-based matching
		const macMap = new Map<number, string | null>();
		for (const result of results) {
			macMap.set(result.id, result.lxcMac);
		}

		// Fetch Protect status (30s cache, cheap on 10s polling) and flapping cameras
		let protectMatches = new Map<number, ProtectCameraMatch>();
		let protectConfigured = false;
		let flappingIds: number[] = [];
		try {
			const protectStatus = await getProtectStatus(macMap);
			protectConfigured = protectStatus.connected;
			protectMatches = protectStatus.cameras;
		} catch {
			// Protect unreachable — continue without
		}
		try {
			flappingIds = getFlappingCameras();
		} catch {
			// Events DB issue — continue without
		}

		// Get UniFi host for Protect deep-links
		let unifiHost: string | null = null;
		if (protectConfigured) {
			try {
				const s = await getSettings('unifi_');
				unifiHost = s.unifi_host || null;
			} catch { /* ignore */ }
		}

		// Enrich results with Protect status and flapping
		for (const result of results) {
			(result as any).protectStatus = protectMatches.get(result.id) || null;
			(result as any).protectConfigured = protectConfigured;
			(result as any).protectUrl = unifiHost ? `https://${unifiHost}/protect/devices` : null;
			(result as any).flapping = flappingIds.includes(result.id);
		}

		results.sort((a, b) => a.name.localeCompare(b.name));
		return json(results);
	} catch (err) {
		return json([], { status: 500 });
	}
};
