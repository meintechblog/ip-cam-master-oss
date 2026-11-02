// DetectionService — the single consumable backend seam that COMPOSES the shipped
// C1 ProtectConnection (self-healing realtime connection) and C2 DetectionTap
// (PII-free MinimalEvent normalizer) into one object an HTTP route / UI can read.
//
// Why this layer exists (LEAN-REBUILD-DESIGN v2, C5 Liveness):
//   - C1 owns the connection lifecycle + a 'state' signal; C2 owns detection
//     normalization + a 'detection' signal. Neither is directly consumable by a
//     route: the route needs ONE object that knows "is the tap alive?" and "what
//     did we see recently?". This service is that object.
//   - C5 (Liveness-Heartbeat) is mandatory: a silently-dead tap looks like "nothing
//     happening", which for actuators (door/light/alarm) is a SAFETY bug. So the
//     service exposes connectionState (from C1's FSM) as the liveness surface, and
//     a bounded ring buffer of the most recent MinimalEvents as the demonstrable
//     "what did the tap actually deliver" evidence.
//
// Scope guard (local-first / R12):
//   - NO MQTT egress (that is C3, deferred — smart-home owns the broker).
//   - NO UI, NO network calls of its own — it only wires C1 ⇄ C2 and observes.
//   - NEVER logs a MinimalEvent field in cleartext (log-redaction constraint).
//   - The singleton does NOT auto-open the live connection on import. Wiring the
//     observers is cheap + side-effect-free; opening the ws is an explicit start().

import { EventEmitter } from 'node:events';
import { ProtectConnection, getProtectConnection, type StartResult } from './protect-connection';
import { DetectionTap, getDetectionTap, type MinimalEvent, type RecognitionEvent } from './detection-tap';
import type { ConnState } from './protect-connection-fsm';

// Keep the recent-events window small + bounded: this is a liveness/debug surface,
// not an event store (events.ts / SQLite owns persistence). 50 is enough to show a
// route caller "the tap is delivering" without unbounded memory growth.
export const DEFAULT_RECENT_LIMIT = 50;

/** The exact read-only shape a status route serializes. No PII beyond MinimalEvent. */
export interface DetectionStatus {
	/** C1 connection FSM state — the liveness signal. 'disconnected' when no creds. */
	connectionState: ConnState;
	/** True once start() has opened (or attempted) the connection this process. */
	started: boolean;
	/** ms timestamp of the most recent MinimalEvent the tap delivered, or null. */
	lastEventAt: number | null;
	/** Most-recent-first bounded slice of delivered MinimalEvents (PII-free). */
	recent: MinimalEvent[];
}

/** Minimal C1 surface this service drives — lets tests inject a fake connection. */
export interface ConnectionLike {
	getState(): ConnState;
	onStateChange(listener: (state: ConnState) => void): void;
	start(): Promise<StartResult>;
	stop(): Promise<void>;
}

/** Minimal C2 surface this service drives — lets tests inject a fake tap. */
export interface TapLike {
	onDetection(listener: (event: MinimalEvent) => void): void;
	/** Optional — fakes without a recognition seam stay valid; wiring is skipped. */
	onRecognition?(listener: (event: RecognitionEvent) => void): void;
	attach(connection: { onPacket(listener: (packet: unknown) => void): void }): void;
	stop(): void;
}

export type DetectionServiceDeps = {
	/** C1 connection. Defaults to the process-wide getProtectConnection() singleton. */
	connection?: ConnectionLike;
	/** C2 tap. Defaults to the process-wide getDetectionTap() singleton. */
	tap?: TapLike;
	/** Ring-buffer capacity for the recent-events window. */
	recentLimit?: number;
	/** Injectable clock (ms). Defaults to Date.now. */
	now?: () => number;
};

export class DetectionService extends EventEmitter {
	private readonly connection: ConnectionLike;
	private readonly tap: TapLike;
	private readonly recentLimit: number;
	private readonly now: () => number;

	// Newest-LAST internally (cheap push/shift); status() reverses to newest-first.
	private readonly recent: MinimalEvent[] = [];
	private lastEventAt: number | null = null;
	private started = false;
	private wired = false;

	constructor(deps: DetectionServiceDeps = {}) {
		super();
		this.connection = deps.connection ?? getProtectConnection();
		this.tap = deps.tap ?? getDetectionTap();
		this.recentLimit = deps.recentLimit ?? DEFAULT_RECENT_LIMIT;
		this.now = deps.now ?? Date.now;
		// The SSE live route (src/routes/api/detections/live/+server.ts) subscribes one
		// 'detection' listener PER connected client; lift Node's default 10-listener cap
		// so many concurrent SSE viewers do not trip MaxListenersExceededWarning.
		this.setMaxListeners(0);
	}

	// ── public API ─────────────────────────────────────────────────────────────

	/**
	 * Wire the observers (C2.attach(C1), C1 'state' → re-emit, C2 'detection' →
	 * ring buffer + re-emit). Side-effect-free w.r.t. the network: it does NOT open
	 * the ws. Idempotent — calling twice does not double-wire. Safe to call from a
	 * route on first access so a status read works before start().
	 */
	wire(): void {
		if (this.wired) return;
		this.wired = true;

		// C2 consumes C1's 'packet' seam. attach() also arms C2's orphan reaper.
		this.tap.attach(this.connection as unknown as { onPacket(l: (p: unknown) => void): void });

		// Re-emit connection-state transitions so a route/UI can subscribe to one seam.
		this.connection.onStateChange((state) => {
			this.emit('state', state);
		});

		// Record + re-emit every finalized detection. NEVER log the event fields.
		this.tap.onDetection((event) => {
			this.record(event);
			this.emit('detection', event);
		});

		// Re-emit PII-free recognition verdicts (known/unknown face & vehicle).
		this.tap.onRecognition?.((event) => {
			this.emit('recognition', event);
		});
	}

	/**
	 * Open the live connection. Wires first (idempotent). Returns C1's tagged
	 * StartResult — { ok:false, reason:'auth_failed' } when no creds are configured
	 * (the no-creds path is graceful: state stays 'disconnected', never throws).
	 */
	async start(): Promise<StartResult> {
		this.wire();
		this.started = true;
		return this.connection.start();
	}

	/** Tear down both halves. Leaves the recent buffer intact for a final read. */
	async stop(): Promise<void> {
		this.tap.stop();
		await this.connection.stop();
		this.started = false;
	}

	/** Subscribe to finalized MinimalEvents (the same seam C3/UI consume). */
	onDetection(listener: (event: MinimalEvent) => void): void {
		this.on('detection', listener);
	}

	/** Subscribe to C1 connection-state transitions (the liveness seam). */
	onStateChange(listener: (state: ConnState) => void): void {
		this.on('state', listener);
	}

	/** Subscribe to PII-free recognition verdicts (known/unknown face & vehicle). */
	onRecognition(listener: (event: RecognitionEvent) => void): void {
		this.on('recognition', listener);
	}

	/**
	 * Current C1 connection liveness, read straight off the FSM. Lets a late
	 * subscriber (the MQTT publisher) seed the CURRENT health on start() instead of
	 * waiting for the next transition — closing the health-race where an initial
	 * 'connected' transition that happened before the publisher wired would otherwise
	 * leave `ipcam/health` retained 'offline'. Pure observation, never opens the ws.
	 */
	getConnectionState(): ConnState {
		return this.connection.getState();
	}

	/**
	 * Read-only status snapshot. Pure observation — calling this NEVER opens a
	 * connection and NEVER throws, even with no creds configured (connectionState
	 * is read straight off C1's FSM, which defaults to 'disconnected').
	 */
	status(): DetectionStatus {
		return {
			connectionState: this.connection.getState(),
			started: this.started,
			lastEventAt: this.lastEventAt,
			// Newest-first, fully defensive copy: a new array AND a per-event shallow
			// clone (MinimalEvent is a flat record) so a caller mutating the returned
			// snapshot can never corrupt the live liveness buffer.
			recent: this.recent.map((e) => ({ ...e })).reverse()
		};
	}

	// ── internals ───────────────────────────────────────────────────────────────

	/** Push into the bounded ring buffer (oldest evicted past capacity). */
	private record(event: MinimalEvent): void {
		this.lastEventAt = this.now();
		this.recent.push(event);
		while (this.recent.length > this.recentLimit) {
			this.recent.shift();
		}
	}
}

// ── module-level singleton (lazy, long-lived — NOT TTL'd) ──────────────────────
let _service: DetectionService | null = null;

/**
 * Lazy accessor for the process-wide DetectionService. Constructing it is cheap and
 * side-effect-free (no network, no wiring). Whoever boots the lean stack calls
 * getDetectionService().start() once; a status route may call wire() to observe
 * before start() without opening the ws.
 */
export function getDetectionService(): DetectionService {
	if (!_service) {
		_service = new DetectionService();
	}
	return _service;
}
