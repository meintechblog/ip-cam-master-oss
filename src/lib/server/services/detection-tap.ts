// C2 DetectionTap — the thin I/O wrapper that turns C1's raw `'packet'` stream
// into a clean, low-volume, PII-free stream of finalized `MinimalEvent`s.
//
// Mirrors the split established by C1: all decision arithmetic lives in the pure
// `detection-tap-fsm.ts`; this module owns ONLY the side-effecting plumbing — a
// per-event state Map (keyed on the Protect event id), a per-(camera,type)
// cooldown Map, the real clock, and the orphan-reaper interval. It re-emits a
// single `'detection'` event carrying a `MinimalEvent`; that event is the ONLY
// outward seam (the place C3 will wire MQTT egress to).
//
// Scope guard: NO MQTT, NO UI, NO network calls of its own. It only consumes the
// C1 connection's `onPacket` seam. No MinimalEvent field is ever logged in
// cleartext (local-first / log-redaction constraint).

import { EventEmitter } from 'node:events';
import {
	computeConfirmations,
	computeEnd,
	cooldownKey,
	isCoolingDown,
	isOrphanExpired,
	parseEventPacket,
	parseRecognitionPacket,
	DEFAULT_CONFIRM_SCORE,
	DEFAULT_COOLDOWN_MS,
	DEFAULT_EVENT_TTL_MS,
	type CooldownKey,
	type EventState,
	type MinimalEvent,
	type RecognitionEvent
} from './detection-tap-fsm';

// Re-export the outward contract so consumers (tests, C3) import it from the
// wrapper without reaching into the pure FSM module.
export type { MinimalEvent, DetectionPhase, RecognitionEvent } from './detection-tap-fsm';

// Recognition labels can trail the event's `end` packet by a few seconds (measured
// on the live wire 2026-06-11: a metadata-only update arrived 7s after `ended`).
// Ended events leave a camera tombstone for this window so those late verdicts can
// still resolve their camera instead of being dropped.
const RECOGNITION_TOMBSTONE_MS = 30_000;

/** Minimal upstream surface this tap consumes — satisfied by C1 ProtectConnection. */
export interface PacketSource {
	onPacket(listener: (packet: unknown) => void): void;
}

export type DetectionTapDeps = {
	/** Injectable clock (ms). Defaults to Date.now. */
	now?: () => number;
	/** Minimum score for a 'confirmed' emit. */
	confirmScore?: number;
	/** Per-(camera,type) cooldown window for 'confirmed' emits. */
	cooldownMs?: number;
	/** Orphan reaper window — events with no clean 'end' are swept after this. */
	eventTtlMs?: number;
	/** Reaper poll cadence. Defaults to ~eventTtlMs/3 (min 1000), mirroring C1's watchdog tick. */
	reaperIntervalMs?: number;
};

type DetectionListener = (event: MinimalEvent) => void;

export class DetectionTap extends EventEmitter {
	private readonly now: () => number;
	private readonly confirmScore: number;
	private readonly cooldownMs: number;
	private readonly eventTtlMs: number;
	private readonly reaperIntervalMs: number;

	// Per-event state keyed by the Protect event id (NOT per camera — a camera can
	// have several concurrent events, and a single event can grow its type set).
	private readonly state = new Map<string, EventState>();
	// Per-(camera,type) last-forwarded timestamp, for the cooldown gate.
	private readonly lastEmitAt = new Map<CooldownKey, number>();
	// Camera tombstones for ended events (late recognition labels still resolve).
	private readonly endedCameras = new Map<string, { camera: string; diedAt: number }>();
	// Per-event recognition dedupe (`${kind}:${known}` marks already emitted).
	private readonly recognitionSeen = new Map<string, Set<string>>();

	private reaperTimer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(deps: DetectionTapDeps = {}) {
		super();
		this.now = deps.now ?? Date.now;
		this.confirmScore = deps.confirmScore ?? DEFAULT_CONFIRM_SCORE;
		this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.eventTtlMs = deps.eventTtlMs ?? DEFAULT_EVENT_TTL_MS;
		this.reaperIntervalMs = deps.reaperIntervalMs ?? Math.max(1000, Math.floor(this.eventTtlMs / 3));
	}

	// ── public API ─────────────────────────────────────────────────────────────

	/** Subscribe a downstream consumer (the C3 MQTT seam) to finalized detections. */
	onDetection(listener: DetectionListener): void {
		this.on('detection', listener);
	}

	/** Subscribe to PII-free recognition verdicts (known/unknown face & vehicle). */
	onRecognition(listener: (event: RecognitionEvent) => void): void {
		this.on('recognition', listener);
	}

	/** Wire this tap to a C1-style packet source and arm the orphan reaper. */
	attach(connection: PacketSource): void {
		this.stopped = false;
		connection.onPacket((packet: unknown) => this.ingest(packet));
		this.startReaper();
	}

	/**
	 * Fold one decoded ws packet into the per-event state and emit any finalized
	 * MinimalEvents. Public so fixtures/tests can drive it directly. Non-'event'
	 * modelKeys and malformed packets are ignored (parseEventPacket returns null).
	 */
	ingest(packet: unknown): void {
		// Recognition labels ride on metadata-only updates that parseEventPacket
		// rejects (no camera in the payload) — scan them FIRST, independently.
		this.ingestRecognition(packet);

		const parsed = parseEventPacket(packet);
		if (!parsed) return; // ignore non-event modelKeys + malformed packets

		const now = this.now();
		const prior = this.state.get(parsed.id);

		const { nextState, emit } = computeConfirmations(prior, parsed, now, this.confirmScore);

		for (const detection of emit) {
			const key = cooldownKey(detection.camera, detection.type);
			if (isCoolingDown(this.lastEmitAt.get(key), now, this.cooldownMs)) {
				// Suppress the forward, but KEEP the confirmedTypes mark in nextState
				// so a flapping detector cannot retry-spam this (camera,type).
				continue;
			}
			this.lastEmitAt.set(key, now);
			this.emit('detection', detection);
		}

		// A non-zero `end` closes the event: emit 'ended' per confirmed type
		// (NOT cooldown-gated — an end must always be deliverable so downstream
		// can clear state), then free the event entry.
		if (parsed.end !== 0) {
			const { emit: endEmit } = computeEnd(nextState, now);
			for (const detection of endEmit) {
				this.emit('detection', detection);
			}
			this.state.delete(parsed.id);
			// Late recognition labels (measured up to ~7s after `end`) still need the
			// camera — keep a tombstone; the reaper sweeps it after the window.
			this.endedCameras.set(parsed.id, { camera: nextState.camera, diedAt: now });
			return;
		}

		this.state.set(parsed.id, nextState);
	}

	/**
	 * Extract PII-free recognition verdicts from a packet and emit each (event,
	 * kind, known) combination exactly once. Camera resolution: live event state
	 * first, then the ended-tombstone (labels often land AT/after `end`). A verdict
	 * for an event this tap never tracked is dropped — no camera, no emit.
	 */
	private ingestRecognition(packet: unknown): void {
		const rec = parseRecognitionPacket(packet);
		if (!rec) return;
		const camera = this.state.get(rec.id)?.camera ?? this.endedCameras.get(rec.id)?.camera;
		if (!camera) return;

		const now = this.now();
		let seen = this.recognitionSeen.get(rec.id);
		if (!seen) {
			seen = new Set<string>();
			this.recognitionSeen.set(rec.id, seen);
		}
		for (const mark of rec.marks) {
			const key = `${mark.kind}:${mark.known}`;
			if (seen.has(key)) continue;
			seen.add(key);
			this.emit('recognition', {
				camera,
				kind: mark.kind,
				known: mark.known,
				ts: now
			} satisfies RecognitionEvent);
		}
	}

	/** Clear the reaper interval and drop all tracked state. */
	stop(): void {
		this.stopped = true;
		if (this.reaperTimer) {
			clearInterval(this.reaperTimer);
			this.reaperTimer = null;
		}
		this.state.clear();
		this.lastEmitAt.clear();
		this.endedCameras.clear();
		this.recognitionSeen.clear();
	}

	// ── internals ───────────────────────────────────────────────────────────────

	/**
	 * Sweep orphaned events (got 'add', never a clean 'end') past the TTL: emit a
	 * synthetic 'ended' per confirmed type so downstream can close any presence it
	 * opened, then free the state. An orphan that never confirmed emits nothing
	 * but is still freed. Public so fixtures/tests can drive the reaper directly
	 * (the timer just calls this on its cadence).
	 */
	reap(): void {
		const now = this.now();
		for (const [id, state] of this.state) {
			if (!isOrphanExpired(state, now, this.eventTtlMs)) continue;
			const { emit } = computeEnd(state, now);
			for (const detection of emit) {
				this.emit('detection', detection);
			}
			this.state.delete(id);
			// Same tombstone as the clean `end` path (Codex F5): a lost end packet
			// must not also cost the late recognition verdict its camera resolution.
			this.endedCameras.set(id, { camera: state.camera, diedAt: now });
		}
		// Sweep recognition tombstones + dedupe sets past their window. The dedupe
		// set of a LIVE event must survive (state still present); everything else
		// (ended + window elapsed, or never tracked anymore) is freed here.
		for (const [id, tomb] of this.endedCameras) {
			if (now - tomb.diedAt >= RECOGNITION_TOMBSTONE_MS) {
				this.endedCameras.delete(id);
				if (!this.state.has(id)) this.recognitionSeen.delete(id);
			}
		}
		for (const id of this.recognitionSeen.keys()) {
			if (!this.state.has(id) && !this.endedCameras.has(id)) {
				this.recognitionSeen.delete(id);
			}
		}
		// Prune cooldown entries that can NEVER suppress again: once `now - lastEmit`
		// reaches the cooldown window, isCoolingDown() returns false for that key, so
		// dropping it is behavior-neutral and keeps lastEmitAt bounded by the ACTIVE
		// (camera,type) set (it is otherwise unbounded by-construction). Live keys
		// (still inside their window) are untouched, so cooldown semantics are preserved.
		for (const [key, lastEmit] of this.lastEmitAt) {
			if (now - lastEmit >= this.cooldownMs) {
				this.lastEmitAt.delete(key);
			}
		}
	}

	private startReaper(): void {
		if (this.reaperTimer) clearInterval(this.reaperTimer);
		this.reaperTimer = setInterval(() => {
			if (this.stopped) return;
			this.reap();
		}, this.reaperIntervalMs);
		// Do not keep the event loop alive solely for the reaper (real timers only;
		// fake timers in tests have no unref()).
		(this.reaperTimer as { unref?: () => void }).unref?.();
	}
}

// ── module-level singleton (lazy, long-lived) ──────────────────────────────────
let _tap: DetectionTap | null = null;

/**
 * Lazy accessor for the process-wide DetectionTap. Deliberately does NOT
 * auto-attach to the connection — wiring `getDetectionTap().attach(getProtectConnection())`
 * is a startup concern deferred to whoever boots the lean stack.
 */
export function getDetectionTap(): DetectionTap {
	if (!_tap) {
		_tap = new DetectionTap();
	}
	return _tap;
}
