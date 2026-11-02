// Bird-Eye M2 Slice 2 — on-demand position feed for the /live/karte aerial view.
//
// Data source is the Protect EVENTS REST API (last N minutes, smartDetectZone),
// fetched through the authenticated lib client — deliberately NOT the detection
// pipeline, so the PII-free MQTT/MinimalEvent contract stays untouched. The UI
// polls this endpoint every 3s (R41 test negative: single-viewer LAN tool → R12
// lean poll; SSE is a Slice-3 option). Local-first: positions are served only to
// the LAN-bound UI and never leave the LAN.
//
// PII GATE (whitelist-copy, mirroring detection-tap-fsm.ts): from each event we
// read ONLY camera/start/smartDetectTypes and per thumbnail ONLY type/coord/
// confidence. labels (plate text / face groups!), croppedId, objectId,
// attributes, metadata passthrough — none of that ever reaches the response.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProtectClient } from '$lib/server/services/protect-bridge';
import {
	getBirdeyeCalibration,
	listBirdeyeCalibrations,
	mapDetection
} from '$lib/server/services/birdeye-mapper';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Served copy of the calibrated aerial image (static/birdeye/luftbild.jpg,
// 1101x823 — matches BirdeyeCalibration.mapSize).
const MAP_IMAGE = '/birdeye/luftbild.jpg';
const MAP_SIZE = { width: 1101, height: 823 };

const DEFAULT_MINUTES = 10;
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;

// Circuit breaker — protects the SHARED ProtectApi singleton. unifi-protect@4.29
// increments apiErrorCount on every failed retrieve(); at 10 errors the lib
// throttles for 300s AND reset() tears down the events WS that feeds the
// detection pipeline (night-watch source!). A 3s UI poll against a persistently
// failing controller reaches that in ~30s — so after one failed Protect access
// we serve the last failure response for BREAKER_MS without touching Protect.
const BREAKER_MS = 30_000;
let breakerUntil = 0;
let breakerStatus = 200;
let breakerPayload: Record<string, unknown> | null = null;

function tripBreaker(status: number, payload: Record<string, unknown>): Response {
	breakerUntil = Date.now() + BREAKER_MS;
	breakerStatus = status;
	breakerPayload = payload;
	return json({ ...payload, retryAfterMs: BREAKER_MS }, { status, headers: NO_STORE });
}

function resetBreaker(): void {
	breakerUntil = 0;
	breakerPayload = null;
}

/** Outward shape — EXACTLY these fields, asserted in tests. */
type BirdeyePosition = {
	camera: string;
	cameraName: string;
	type: string;
	score?: number;
	ts: number;
	x: number;
	y: number;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

function clampMinutes(raw: string | null): number {
	// Empty/whitespace string would coerce to Number('') === 0 → clamp to 1;
	// treat it like any other unparsable input and fall back to the default.
	if (raw === null || raw.trim() === '') return DEFAULT_MINUTES;
	const n = Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_MINUTES;
	return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.trunc(n)));
}

/**
 * Pick the NEWEST detectedThumbnails entry that carries a valid coord and a
 * type matching the event's smartDetectTypes (later array entries are the
 * later observations). Returns a whitelist-copy — never the raw thumb object.
 */
function pickLatestCoordThumb(
	ev: Record<string, unknown>
): { type: string; coord: [number, number, number, number]; confidence?: number } | null {
	const metadata = ev.metadata;
	if (!isRecord(metadata)) return null;
	const thumbs = metadata.detectedThumbnails;
	if (!Array.isArray(thumbs)) return null;
	const smartTypes = Array.isArray(ev.smartDetectTypes)
		? ev.smartDetectTypes.filter((t): t is string => typeof t === 'string')
		: [];
	for (let i = thumbs.length - 1; i >= 0; i--) {
		const thumb = thumbs[i];
		if (!isRecord(thumb)) continue;
		const type = thumb.type;
		if (typeof type !== 'string' || type.length === 0) continue;
		// "passender Typ": only thumbs of a type the event actually detected
		// (skips e.g. companion 'face' thumbs on a person event).
		if (smartTypes.length > 0 && !smartTypes.includes(type)) continue;
		const coord = thumb.coord;
		if (
			!Array.isArray(coord) ||
			coord.length !== 4 ||
			!coord.every((n) => typeof n === 'number' && Number.isFinite(n))
		) {
			continue;
		}
		return {
			type,
			coord: [coord[0], coord[1], coord[2], coord[3]],
			confidence: typeof thumb.confidence === 'number' ? thumb.confidence : undefined
		};
	}
	return null;
}

export const GET: RequestHandler = async ({ url }) => {
	const minutes = clampMinutes(url.searchParams.get('minutes'));

	// Breaker open → replay the last failure response WITHOUT touching the
	// shared Protect client. retryAfterMs tells the UI how long the lock holds.
	const now = Date.now();
	if (now < breakerUntil && breakerPayload) {
		return json(
			{ ...breakerPayload, retryAfterMs: breakerUntil - now },
			{ status: breakerStatus, headers: NO_STORE }
		);
	}

	try {
		const client = await getProtectClient();
		if (!client.bootstrap) {
			const ok = await client.getBootstrap();
			if (!ok) {
				return tripBreaker(200, {
					ok: true,
					mapImage: MAP_IMAGE,
					mapSize: MAP_SIZE,
					positions: [],
					reason: 'disconnected'
				});
			}
		}

		const end = Date.now();
		const start = end - minutes * 60_000;
		// Lib exposes no bare host — derive the events URL from a known endpoint.
		const eventsUrl =
			client.getApiEndpoint('bootstrap').replace(/\/bootstrap$/, '/events') +
			`?start=${start}&end=${end}&types=smartDetectZone&limit=100`;

		// NOTE: retrieve() returns an UNDICI ResponseData (statusCode/body.json()),
		// NOT a fetch Response (.ok/.json()) — verified 2026-06-10. With the
		// default decodeResponse it never resolves to a non-2xx response either:
		// non-2xx/timeout → null. logErrors:false keeps a failing 3s poll from
		// spamming the lib's error log.
		const resp = await client.retrieve(eventsUrl, undefined, { logErrors: false });
		if (!resp || resp.statusCode !== 200) {
			return tripBreaker(502, { ok: false, reason: 'events_unavailable', positions: [] });
		}
		const events = await resp.body.json();
		if (!Array.isArray(events)) {
			// retrieve() itself succeeded (no apiErrorCount increment in the lib),
			// so this malformed-body case does NOT trip the breaker.
			return json(
				{ ok: false, reason: 'events_unavailable', positions: [] },
				{ status: 502, headers: NO_STORE }
			);
		}
		resetBreaker();

		const nameById = new Map(
			(client.bootstrap?.cameras ?? []).map((c) => [c.id, c.name ?? c.id] as const)
		);

		const positions: BirdeyePosition[] = [];
		for (const ev of events) {
			if (!isRecord(ev)) continue;
			const cameraId = typeof ev.camera === 'string' ? ev.camera : '';
			const cal = getBirdeyeCalibration(cameraId);
			if (!cal) continue; // only calibrated cameras can be placed on the map
			const ts = typeof ev.start === 'number' ? ev.start : null;
			if (ts === null) continue;
			const picked = pickLatestCoordThumb(ev);
			if (!picked) continue;
			const mapped = mapDetection(cal, picked.coord);
			if (!mapped) continue; // horizon / behind camera / out of map
			positions.push({
				camera: cameraId,
				cameraName: nameById.get(cameraId) ?? cameraId,
				type: picked.type,
				...(picked.confidence !== undefined ? { score: picked.confidence } : {}),
				ts,
				x: Math.round(mapped.x * 10) / 10,
				y: Math.round(mapped.y * 10) / 10
			});
		}
		positions.sort((a, b) => a.ts - b.ts); // oldest first → newest renders on top

		// Calibrated camera names for the UI's empty-state hint (names only).
		const calibrated = listBirdeyeCalibrations().map(
			(c) => nameById.get(c.cameraId) ?? c.cameraId
		);

		return json(
			{ ok: true, mapImage: MAP_IMAGE, mapSize: MAP_SIZE, positions, calibrated },
			{ headers: NO_STORE }
		);
	} catch {
		// Graceful no-creds / client-error path (contract shared with
		// /api/detections/status): 200 + empty positions, never a throw.
		// Also trips the breaker — a throwing Protect access (retrieve/bootstrap)
		// must not be retried every 3s against the shared client.
		return tripBreaker(200, {
			ok: true,
			mapImage: MAP_IMAGE,
			mapSize: MAP_SIZE,
			positions: [],
			reason: 'disconnected'
		});
	}
};
