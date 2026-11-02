/**
 * stream-health-sampler.ts — 30s probe loop that exports per-camera health
 * to Influx so phantom adoptions are visible within one tick.
 *
 * Two layers per tick:
 *   1. go2rtc probe per managed cam (containerIp:1984/api/streams) — counts
 *      configured-vs-started producers, active consumers, accumulated
 *      bytes_recv. A camera with started=0 and bytes=0 over multiple ticks
 *      is exactly the Balkon failure mode (Protect not pulling).
 *   2. Protect bootstrap fetch (once per tick) — exposes the controller's
 *      view: state, lastSeen, recordingEnd. We compute
 *      `recording_end_age_seconds` so dashboards/alerts trip on stuck
 *      recordings without having to do epoch math in Flux.
 *
 * Phantom-adoption alert (camera_alert measurement, field `phantom`):
 *   fires when state == "CONNECTED" but recording_end_age_seconds > 90s.
 *   This is the Balkon-2026-05-28 fingerprint.
 *
 * Skips Bambu cams in adaptive-idle mode — their go2rtc is intentionally
 * dormant when the printer is finished (see scheduler.ts:95-103 for the
 * same accommodation in container health checks).
 *
 * Singleton, idempotent start/stop, mirrors the protect-hub ws-manager
 * pattern. Sampling cadence is fixed at 30s to match the existing Protect
 * poll cache; lower would burn the cache, higher would mask short stalls.
 */

import { db } from '$lib/server/db/client';
import { cameras, streamHealth } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { recordMetric } from './metrics';
import { computeStreamRates, type StreamRateSample } from './stream-quality';
import { fetchBootstrap } from './protect-bridge';
import { storeEvent } from './events';
import type { EventType, EventSeverity } from '$lib/types';
import type { ProtectCameraConfig } from 'unifi-protect';

const TICK_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;
const PHANTOM_AGE_THRESHOLD_SECONDS = 90;

let _timer: ReturnType<typeof setInterval> | null = null;
let _tickInFlight = false;

// Quick-task 260530-bv1 — per-stream last-known booleans for edge detection.
// Seeded silently on first observation (and after a restart), so events fire
// only on an actual state TRANSITION, never every tick.
const _prevState = new Map<string, { phantom: boolean; producerAlive: boolean }>();

// Quick-task 260531-3gh — per-stream last counter sample for delta-based rate
// math. Seeded silently on first observation (and after a go2rtc/container
// restart, where computeStreamRates returns null on the backward delta), exactly
// like _prevState above — so rates emit only once a real two-tick delta exists.
const _prevRate = new Map<string, StreamRateSample>();

/**
 * Pure, edge-only transition detection. Emits an event ONLY when a tracked
 * boolean changed since the previous tick. prev === undefined means first
 * observation → seed silently, return no events. Both flags can flip in one
 * tick → all applicable events are returned. EventType/EventSeverity are the
 * existing unions from $lib/types — no new members invented.
 */
export function detectTransitions(
	streamKey: string,
	prev: { phantom: boolean; producerAlive: boolean } | undefined,
	next: { phantom: boolean; producerAlive: boolean },
	ctx: { cameraName: string; recAge: number }
): Array<{ eventType: EventType; severity: EventSeverity; message: string }> {
	if (prev === undefined) return []; // first observation / post-restart — seed only

	const out: Array<{ eventType: EventType; severity: EventSeverity; message: string }> = [];

	if (prev.phantom !== next.phantom) {
		if (next.phantom) {
			out.push({
				eventType: 'stream_failed',
				severity: 'error',
				message: `Phantom-adoption: ${ctx.cameraName} (${streamKey}) state=CONNECTED but recording stalled (recording_end_age=${ctx.recAge}s)`
			});
		} else {
			out.push({
				eventType: 'camera_reconnect',
				severity: 'info',
				message: `Phantom-adoption recovered: ${ctx.cameraName} (${streamKey}) recording resumed`
			});
		}
	}

	if (prev.producerAlive !== next.producerAlive) {
		if (!next.producerAlive) {
			out.push({
				eventType: 'stream_failed',
				severity: 'warning',
				message: `go2rtc producer died: ${ctx.cameraName} (${streamKey}) no started producers`
			});
		} else {
			out.push({
				eventType: 'camera_reconnect',
				severity: 'info',
				message: `go2rtc producer recovered: ${ctx.cameraName} (${streamKey}) producing again`
			});
		}
	}

	return out;
}

export interface Go2rtcProbe {
	reachable: boolean;
	streamFound: boolean;
	producersConfigured: number;
	producersStarted: number;
	consumers: number;
	bytesRecv: number;
	// Quick-task 260531-3gh — additive safe stream-quality fields.
	// packets: Σ receivers[].packets across all producers (0 when none).
	// codec*: from the FIRST receiver whose codec.codec_type === 'video' (null when absent).
	// 🔴 Derived ONLY from receivers[].{bytes,packets,codec} + producer.bytes_recv —
	// producer.source / producer.url (clear-text camera credentials) are NEVER read.
	packets: number;
	codecName: string | null;
	codecProfile: string | null;
	codecLevel: number | null;
	error?: string;
}

export async function probeGo2rtc(containerIp: string, streamName: string): Promise<Go2rtcProbe> {
	try {
		const r = await fetch(`http://${containerIp}:1984/api/streams`, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		if (!r.ok) {
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
				error: `HTTP ${r.status}`
			};
		}
		const data = (await r.json()) as Record<string, { producers?: unknown[]; consumers?: unknown[] | null }>;
		const stream = data[streamName];
		if (!stream) {
			return {
				reachable: true,
				streamFound: false,
				producersConfigured: 0,
				producersStarted: 0,
				consumers: 0,
				bytesRecv: 0,
				packets: 0,
				codecName: null,
				codecProfile: null,
				codecLevel: null
			};
		}
		// 🔴 Read ONLY safe fields: producer.bytes_recv + receivers[].{bytes,packets,codec}.
		// producer.source / producer.url carry clear-text camera credentials — never read.
		type Receiver = {
			bytes?: number;
			packets?: number;
			codec?: { codec_name?: string; codec_type?: string; profile?: string; level?: number };
		};
		const prods = (stream.producers ?? []) as Array<{ id?: number; bytes_recv?: number; receivers?: Receiver[] }>;
		const cons = (stream.consumers ?? []) as unknown[];
		const started = prods.filter((p) => typeof p?.id === 'number').length;
		const bytes = prods.reduce((acc, p) => acc + (typeof p?.bytes_recv === 'number' ? p.bytes_recv : 0), 0);

		// Σ receivers[].packets across all producers; pick the first video receiver's
		// codec for static name/profile/level.
		let packets = 0;
		let codecName: string | null = null;
		let codecProfile: string | null = null;
		let codecLevel: number | null = null;
		for (const p of prods) {
			const receivers = Array.isArray(p?.receivers) ? p.receivers : [];
			for (const rec of receivers) {
				if (typeof rec?.packets === 'number') packets += rec.packets;
				if (codecName === null && rec?.codec?.codec_type === 'video') {
					codecName = typeof rec.codec.codec_name === 'string' ? rec.codec.codec_name : null;
					codecProfile = typeof rec.codec.profile === 'string' ? rec.codec.profile : null;
					codecLevel = typeof rec.codec.level === 'number' ? rec.codec.level : null;
				}
			}
		}

		return {
			reachable: true,
			streamFound: true,
			producersConfigured: prods.length,
			producersStarted: started,
			consumers: Array.isArray(cons) ? cons.length : 0,
			bytesRecv: bytes,
			packets,
			codecName,
			codecProfile,
			codecLevel
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

// Returns the probe result so tick() can reconcile it with the Protect match
// for SQLite writes (260530-bv1). Returns null when the cam is skipped
// (no container / adaptive-idle Bambu) — exactly the cases the Influx path
// already skips. The Influx recordMetric call below is UNCHANGED.
function sampleGo2rtcForCam(cam: { id: number; name: string; cameraType: string; vmid: number; containerIp: string | null; streamName: string; streamMode: string | null; printState: string | null }): Promise<Go2rtcProbe | null> {
	if (!cam.containerIp || !cam.streamName) return Promise.resolve(null);
	const isAdaptiveIdle =
		cam.cameraType === 'bambu' &&
		(cam.streamMode ?? 'adaptive') === 'adaptive' &&
		(cam.printState === 'FINISH' ||
			cam.printState === 'IDLE' ||
			cam.printState === 'PAUSE' ||
			cam.printState === 'FAILED' ||
			cam.printState === null);
	if (isAdaptiveIdle) return Promise.resolve(null);

	return probeGo2rtc(cam.containerIp, cam.streamName).then((p) => {
		const tags = {
			camera_id: String(cam.id),
			camera_name: cam.name,
			camera_type: cam.cameraType,
			vmid: String(cam.vmid),
			stream_name: cam.streamName
		};
		// Quick-task 260531-3gh — derive current bitrate/packet-rate from the
		// delta vs. the previous tick (pure, total function — cannot throw). Seed
		// tick and counter-reset tick → null rates; recordMetric skips null fields,
		// so no fake zeros are written. SQLite/event path (recordCamHealth) untouched.
		const next: StreamRateSample = { bytesRecv: p.bytesRecv, packets: p.packets, tsMs: Date.now() };
		const rates = computeStreamRates(_prevRate.get(cam.streamName), next);
		_prevRate.set(cam.streamName, next);
		recordMetric({
			measurement: 'camera_go2rtc',
			tags,
			fields: {
				reachable: p.reachable,
				stream_found: p.streamFound,
				producers_configured: p.producersConfigured,
				producers_started: p.producersStarted,
				consumers: p.consumers,
				bytes_recv_total: BigInt(p.bytesRecv),
				producer_alive: p.producersStarted > 0,
				consumer_alive: p.consumers > 0,
				error: p.error,
				// Additive stream-quality fields (260531-3gh). codec_name kept as a
				// FIELD (not a tag) to avoid an Influx series/schema change on the
				// existing camera_go2rtc measurement. null rate/codec fields are
				// skipped by recordMetric → absent on seed/reset ticks, not faked.
				packets_total: BigInt(p.packets),
				actual_bitrate_kbps: rates.bitrateKbps,
				packet_rate_pps: rates.packetRatePps,
				codec_name: p.codecName,
				codec_profile: p.codecProfile,
				codec_level: p.codecLevel
			}
		});
		return p;
	});
}

// Quick-task 260530-bv1 — additive SQLite writes for a managed cam, derived
// from the SAME values already sent to Influx. Edge-only events via storeEvent
// (which dedups) + current-snapshot upsert into stream_health. Both writes are
// try/catch-wrapped: a DB error logs and continues, never aborts the tick or
// blocks Influx. recAge defaults to -1 when there is no Protect match this tick
// (phantom cannot trip without a Protect state, but producerAlive still tracks).
function recordCamHealth(
	cam: { id: number; name: string; streamName: string },
	probe: Go2rtcProbe,
	phantom: boolean,
	recAge: number
): void {
	const streamKey = cam.streamName;
	const producerAlive = probe.producersStarted > 0;
	const next = { phantom, producerAlive };
	const prev = _prevState.get(streamKey);

	// (i) edge-only events
	try {
		const transitions = detectTransitions(streamKey, prev, next, { cameraName: cam.name, recAge });
		for (const evt of transitions) {
			storeEvent({
				cameraId: cam.id,
				cameraName: cam.name,
				eventType: evt.eventType,
				severity: evt.severity,
				message: evt.message,
				source: 'app',
				timestamp: new Date().toISOString()
			});
		}
	} catch (err) {
		console.error('[stream-health-sampler] event write error:', (err as Error).message);
	}

	// Update prev AFTER emitting so the next tick compares against this tick.
	_prevState.set(streamKey, next);

	// (ii) current-snapshot upsert
	const status: string = phantom
		? 'phantom'
		: !probe.reachable
			? 'unreachable'
			: !producerAlive
				? 'producer_dead'
				: 'healthy';
	const errorReason = probe.error ?? null;
	const lastProbedAt = new Date().toISOString();
	try {
		db.insert(streamHealth)
			.values({
				cameraId: cam.id,
				cameraName: cam.name,
				streamKey,
				status,
				errorReason,
				producerAlive,
				consumers: probe.consumers,
				recordingEndAgeSeconds: recAge,
				phantomAdoption: phantom,
				lastProbedAt
			})
			.onConflictDoUpdate({
				target: streamHealth.streamKey,
				set: {
					cameraId: cam.id,
					cameraName: cam.name,
					status,
					errorReason,
					producerAlive,
					consumers: probe.consumers,
					recordingEndAgeSeconds: recAge,
					phantomAdoption: phantom,
					lastProbedAt
				}
			})
			.run();
	} catch (err) {
		console.error('[stream-health-sampler] stream_health upsert error:', (err as Error).message);
	}
}

// Returns { phantom, recAge } so tick() can feed the SAME values into the
// SQLite snapshot/event path (260530-bv1). Influx recordMetric calls unchanged.
function sampleProtectForCam(cam: { id: number; name: string; cameraType: string }, pc: ProtectCameraConfig): { phantom: boolean; recAge: number } {
	const now = Date.now();
	const recEnd = (pc.stats as { video?: { recordingEnd?: number } } | undefined)?.video?.recordingEnd ?? null;
	const recAge = recEnd && recEnd > 0 ? Math.floor((now - recEnd) / 1000) : -1;
	const lastSeen = pc.lastSeen ?? null;
	const lastSeenAge = lastSeen && lastSeen > 0 ? Math.floor((now - lastSeen) / 1000) : -1;
	const stateConnected = pc.state === 'CONNECTED';

	const tags = {
		camera_id: String(cam.id),
		camera_name: cam.name,
		camera_type: cam.cameraType,
		protect_id: pc.id,
		protect_state: pc.state ?? 'unknown'
	};
	recordMetric({
		measurement: 'camera_protect',
		tags,
		fields: {
			state_connected: stateConnected,
			is_adopted: pc.isAdopted === true,
			is_recording: pc.isRecording === true,
			is_third_party: pc.isThirdPartyCamera === true,
			connected_since_ms: pc.connectedSince ? BigInt(pc.connectedSince) : 0n,
			last_seen_ms: lastSeen ? BigInt(lastSeen) : 0n,
			last_seen_age_seconds: lastSeenAge,
			recording_end_ms: recEnd ? BigInt(recEnd) : 0n,
			recording_end_age_seconds: recAge
		}
	});

	// Phantom-adoption alert — the Balkon-2026-05-28 fingerprint.
	const phantom = stateConnected && recAge > PHANTOM_AGE_THRESHOLD_SECONDS;
	recordMetric({
		measurement: 'camera_alert',
		tags,
		fields: {
			phantom_adoption: phantom,
			phantom_age_seconds: phantom ? recAge : 0
		}
	});

	return { phantom, recAge };
}

async function tick(): Promise<void> {
	if (_tickInFlight) return; // skip if previous tick is still running
	_tickInFlight = true;
	try {
		const managed = db
			.select()
			.from(cameras)
			.where(eq(cameras.source, 'managed'))
			.all();

		// go2rtc probes in parallel (bounded fan-out — one per cam). Collect the
		// probe result per cam (null = skipped: no container / adaptive-idle) so
		// it can be reconciled with the Protect match below for SQLite writes.
		const probes = await Promise.all(managed.map((cam) => sampleGo2rtcForCam(cam)));
		const probeByCamId = new Map<number, Go2rtcProbe>();
		managed.forEach((cam, i) => {
			const p = probes[i];
			if (p) probeByCamId.set(cam.id, p);
		});

		// One bootstrap fetch shared across all cams
		const boot = await fetchBootstrap();
		const protectByCamId = new Map<number, { phantom: boolean; recAge: number }>();
		if (boot.ok) {
			const byName = new Map<string, ProtectCameraConfig>();
			for (const pc of boot.cameras) {
				const n = (pc.name ?? '').trim().toLowerCase();
				if (n) byName.set(n, pc);
			}
			for (const cam of managed) {
				const pc = byName.get((cam.name ?? '').trim().toLowerCase());
				if (pc) protectByCamId.set(cam.id, sampleProtectForCam(cam, pc));
			}
		} else {
			recordMetric({
				measurement: 'sampler_health',
				fields: { bootstrap_ok: false, reason: boot.reason }
			});
		}

		recordMetric({
			measurement: 'sampler_health',
			fields: { bootstrap_ok: boot.ok, cams_sampled: managed.length }
		});

		// Quick-task 260530-bv1 — additive SQLite writes (events + stream_health).
		// One pass per cam that produced a go2rtc probe (skips no-container /
		// adaptive-idle cams exactly as the Influx path does). A missing Protect
		// match → phantom=false, recAge=-1 (cannot trip phantom without a Protect
		// state, but producerAlive still tracks from the probe). recordCamHealth
		// is fully try/catch-wrapped internally so one bad row can't abort the rest.
		for (const cam of managed) {
			const probe = probeByCamId.get(cam.id);
			if (!probe) continue;
			const protect = protectByCamId.get(cam.id);
			const phantom = protect?.phantom ?? false;
			const recAge = protect?.recAge ?? -1;
			recordCamHealth(cam, probe, phantom, recAge);
		}
	} catch (err) {
		console.error('[stream-health-sampler] tick error:', (err as Error).message);
		recordMetric({ measurement: 'sampler_health', fields: { tick_error: (err as Error).message } });
	} finally {
		_tickInFlight = false;
	}
}

export function startStreamHealthSampler(): void {
	if (_timer) return;
	_timer = setInterval(() => {
		void tick();
	}, TICK_INTERVAL_MS);
	// First tick on next event-loop turn so boot completes first.
	setImmediate(() => void tick());
	console.log(`[stream-health-sampler] started (tick ${TICK_INTERVAL_MS}ms)`);
}

export function stopStreamHealthSampler(): void {
	if (_timer) {
		clearInterval(_timer);
		_timer = null;
	}
}
