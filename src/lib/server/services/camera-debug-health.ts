/**
 * camera-debug-health.ts — Quick-task 260530-fff (Debug-Platform Tier-1 #1).
 *
 * Pure, READ-ONLY aggregator that fans the per-camera health probes out in
 * parallel and folds them into a single typed `CameraDebugHealth` shape for
 * GET /api/cameras/[id]/debug. NO db writes, NO SSH, NO deploy.
 *
 * Reuse, not duplication: the go2rtc layer imports the exact `probeGo2rtc`
 * exported from stream-health-sampler.ts (locked decision — never copy the
 * probe body). The Protect layer reuses the same name-match + phantom logic
 * the sampler uses (state === 'CONNECTED' && recording_end_age > 90s).
 *
 * Fail-soft per layer: every async probe is wrapped so a thrown error becomes
 * that layer's own `{ error }` — the aggregator itself never throws for a probe
 * failure, only a genuinely unexpected bug surfaces upward. The +server.ts
 * route returns 404 ONLY when the camera row is missing.
 *
 * SECURITY (T-fff-02): the decrypted password is used transiently for the
 * device-HTTP reachability probe and is NEVER placed into the response shape.
 */

import { db } from '$lib/server/db/client';
import { streamHealth, type cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { request as httpRequest } from 'node:http';
import { probeGo2rtc } from './stream-health-sampler';
import { fetchBootstrap } from './protect-bridge';
import { verifyOnvifServer } from './protect';
import { getEvents } from './events';
import { decrypt } from './crypto';
import type {
	CameraDebugHealth,
	DebugLayerDevice,
	DebugLayerGo2rtc,
	DebugLayerOnvif,
	DebugLayerProtect,
	DebugLayerSnapshot
} from '$lib/types';
import type { ProtectCameraConfig } from 'unifi-protect';

const PROBE_TIMEOUT_MS = 3_000;
const PHANTOM_AGE_THRESHOLD_SECONDS = 90;

/** The loaded cameras row — typed from the Drizzle select (no `any`). */
type CameraRow = typeof cameras.$inferSelect;

const MOBOTIX_TYPES = new Set(['mobotix', 'mobotix-onvif']);

/**
 * Lean HTTP HEAD/GET reachability probe — mirrors the snapshot route's
 * node:http resolve-never-throw pattern. Resolves the HTTP status (0 on any
 * transport error / timeout); the body is intentionally discarded (we only
 * need reachability, not the frame).
 */
function httpProbeStatus(url: string, authHeader: string, timeoutMs: number): Promise<number> {
	return new Promise((resolve) => {
		const req = httpRequest(
			url,
			{
				method: 'GET',
				headers: { Authorization: authHeader, 'User-Agent': 'ip-cam-master/1', Connection: 'close' },
				agent: false
			},
			(res) => {
				const status = res.statusCode ?? 0;
				// Drain + discard so the socket can close cleanly.
				res.on('data', () => {});
				res.on('end', () => resolve(status));
				res.on('error', () => resolve(status));
			}
		);
		req.on('error', () => resolve(0));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve(0);
		});
		req.end();
	});
}

/**
 * Device-HTTP layer — direct reachability of a Mobotix-class camera via
 * /record/current.jpg (Basic auth). Non-Mobotix cams → applicable:false, no
 * decrypt attempted. Fail-soft: any error folds into `{ error }`.
 */
async function probeDevice(camera: CameraRow): Promise<DebugLayerDevice> {
	if (!MOBOTIX_TYPES.has(camera.cameraType)) {
		return { applicable: false, reachable: false };
	}
	try {
		const password = decrypt(camera.password);
		const authHeader = 'Basic ' + Buffer.from(`${camera.username}:${password}`).toString('base64');
		const status = await httpProbeStatus(
			`http://${camera.ip}/record/current.jpg`,
			authHeader,
			PROBE_TIMEOUT_MS
		);
		return {
			applicable: true,
			reachable: status === 200,
			detail: `HTTP ${status}`
		};
	} catch (err) {
		// Never echo raw crypto/key errors (T-fff-04); keep it generic.
		return { applicable: true, reachable: false, error: 'device probe failed' };
	}
}

/**
 * ONVIF layer — reachability of the BRIDGE container's ONVIF server
 * (`containerIp:8899`), i.e. the endpoint UniFi Protect actually adopts, NOT the
 * camera's native ONVIF. This is the Balkon-forensics signal ("ONVIF green /
 * TCP-conns red" → Protect not pulling). Reuses the canonical verifyOnvifServer
 * probe (ECONNRESET = running). Applicable to any managed cam that has a bridge
 * container; cams without our bridge (no containerIp) → applicable:false.
 * Fail-soft.
 */
async function probeOnvif(camera: CameraRow): Promise<DebugLayerOnvif> {
	if (!camera.containerIp) {
		return { applicable: false, reachable: false };
	}
	try {
		const { reachable } = await verifyOnvifServer(camera.containerIp);
		return { applicable: true, reachable };
	} catch (err) {
		return { applicable: true, reachable: false, error: (err as Error).message };
	}
}

/** go2rtc layer — reuses the imported probeGo2rtc; fail-soft. */
async function probeGo2rtcLayer(camera: CameraRow): Promise<DebugLayerGo2rtc> {
	if (!camera.containerIp || !camera.streamName) {
		return {
			reachable: false,
			streamFound: false,
			producersConfigured: 0,
			producersStarted: 0,
			consumers: 0,
			bytesRecv: 0,
			packets: 0,
			codecName: null,
			codecProfile: null,
			codecLevel: null,
			error: 'no container'
		};
	}
	try {
		const p = await probeGo2rtc(camera.containerIp, camera.streamName);
		// Quick-task 260531-3gh — surface STATIC codec info (name/profile/level) +
		// summed packet counter. Bitrate is delta-based and NOT shown here: this
		// endpoint has no prev sample, so a derived bitrate would need state the
		// endpoint doesn't hold. 🔴 Still safe fields only — never source/url.
		return {
			reachable: p.reachable,
			streamFound: p.streamFound,
			producersConfigured: p.producersConfigured,
			producersStarted: p.producersStarted,
			consumers: p.consumers,
			bytesRecv: p.bytesRecv,
			packets: p.packets,
			codecName: p.codecName,
			codecProfile: p.codecProfile,
			codecLevel: p.codecLevel,
			error: p.error
		};
	} catch (err) {
		return {
			reachable: false,
			streamFound: false,
			producersConfigured: 0,
			producersStarted: 0,
			consumers: 0,
			bytesRecv: 0,
			packets: 0,
			codecName: null,
			codecProfile: null,
			codecLevel: null,
			error: (err as Error).message
		};
	}
}

/**
 * Protect layer — one bootstrap fetch, match by name (case-insensitive trim,
 * same as the sampler), compute the controller's view + phantom flag. On
 * bootstrap failure or no match → matched:false sentinel. Fail-soft.
 */
async function probeProtect(camera: CameraRow): Promise<DebugLayerProtect> {
	const miss: DebugLayerProtect = {
		matched: false,
		state: 'unknown',
		lastSeenAgeSeconds: -1,
		recordingEndAgeSeconds: -1,
		phantom: false
	};
	try {
		const boot = await fetchBootstrap();
		if (!boot.ok) return miss;

		const target = (camera.name ?? '').trim().toLowerCase();
		const pc: ProtectCameraConfig | undefined = boot.cameras.find(
			(c) => (c.name ?? '').trim().toLowerCase() === target && target.length > 0
		);
		if (!pc) return miss;

		const now = Date.now();
		const state = pc.state ?? 'unknown';
		const lastSeen = pc.lastSeen ?? null;
		const lastSeenAgeSeconds = lastSeen && lastSeen > 0 ? Math.floor((now - lastSeen) / 1000) : -1;
		const recEnd =
			(pc.stats as { video?: { recordingEnd?: number } } | undefined)?.video?.recordingEnd ?? null;
		const recordingEndAgeSeconds = recEnd && recEnd > 0 ? Math.floor((now - recEnd) / 1000) : -1;
		const phantom = state === 'CONNECTED' && recordingEndAgeSeconds > PHANTOM_AGE_THRESHOLD_SECONDS;

		return {
			matched: true,
			state,
			isRecording: pc.isRecording === true,
			lastSeenAgeSeconds,
			recordingEndAgeSeconds,
			phantom
		};
	} catch {
		return miss;
	}
}

/** Latest persisted snapshot from the stream_health table (null if no row). */
function readSnapshotLayer(streamName: string): DebugLayerSnapshot | null {
	try {
		const row = db
			.select()
			.from(streamHealth)
			.where(eq(streamHealth.streamKey, streamName))
			.get();
		if (!row) return null;
		return {
			status: row.status,
			producerAlive: row.producerAlive,
			consumers: row.consumers,
			recordingEndAgeSeconds: row.recordingEndAgeSeconds,
			phantomAdoption: row.phantomAdoption,
			lastProbedAt: row.lastProbedAt
		};
	} catch {
		return null;
	}
}

/**
 * Build the full multi-layer health view for one camera. Independent async
 * probes run in parallel; synchronous DB reads (snapshot, recentEvents) run
 * inline. Read-only.
 */
export async function buildCameraDebugHealth(camera: CameraRow): Promise<CameraDebugHealth> {
	const [device, go2rtc, onvif, protect] = await Promise.all([
		probeDevice(camera),
		probeGo2rtcLayer(camera),
		probeOnvif(camera),
		probeProtect(camera)
	]);

	const snapshot = readSnapshotLayer(camera.streamName);
	const recentEvents = getEvents({ cameraId: camera.id, limit: 20 }).events;

	return {
		camera: {
			id: camera.id,
			name: camera.name,
			cameraType: camera.cameraType,
			source: camera.source,
			status: camera.status,
			containerIp: camera.containerIp,
			streamName: camera.streamName,
			vmid: camera.vmid
		},
		layers: { device, go2rtc, onvif, protect, snapshot },
		recentEvents,
		probedAt: new Date().toISOString()
	};
}
