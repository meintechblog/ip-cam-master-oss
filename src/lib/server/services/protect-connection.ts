// C1 ProtectConnection — the self-healing, long-lived UniFi Protect realtime
// connection manager. This is the product core of the lean rebuild
// (see .planning/LEAN-REBUILD-DESIGN.md, v2-Refute section).
//
// Why a NEW module (not protect-bridge.ts):
//   - protect-bridge's getProtectClient() is an 8-min-TTL pull singleton — the
//     WRONG lifecycle for a persistent ws. We must NOT route through it, and the
//     onboarding/settings flow must NOT be able to tear this client down via the
//     shared resetProtectClient(). We reuse only the creds *pattern*
//     (getSettings('unifi_') → new ProtectApi() → login()).
//   - The unifi-protect lib has NO auto-reconnect (on ws-close it just nulls the
//     socket; no retry) AND the ws can die WITHOUT a close event. So C1 owns:
//       (a) reconnect with mandatory getBootstrap()-first ordering (fresh
//           lastUpdateId cursor — never reopen a ws on a stale cursor),
//       (b) exponential backoff + full jitter (anti reconnect-storm),
//       (c) a watchdog on time-since-last-message (the only reliable liveness
//           signal when the ws dies silently),
//       (d) a normalized, observable connection state.
//
// C1 does NOT classify detections, run MQTT, or render UI. It owns ONLY the
// connection lifecycle and a clean pass-through seam for downstream consumers
// (DetectionTap/C2 later). No decoded payload is ever logged in cleartext, and
// C1 makes zero network/cloud calls of its own — only the lib's LAN ws/bootstrap.

import { EventEmitter } from 'node:events';
import { ProtectApi, type ProtectLogging } from 'unifi-protect';
import { getSettings } from './settings';
import {
	computeBackoffMs,
	connectionReducer,
	isSilentlyDead,
	DEFAULT_SILENCE_MS,
	type BackoffOpts,
	type ConnState,
	type ConnectionEvent,
	type ConnectionMachineState
} from './protect-connection-fsm';

// Minimal surface of ProtectApi that C1 actually drives. Defined as an interface
// so tests can inject a plain EventEmitter-based fake without a real controller.
export interface ProtectApiLike {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
	emit(event: string, ...args: unknown[]): boolean;
	removeAllListeners(event?: string): unknown;
	login(nvrAddress: string, username: string, password: string): Promise<boolean>;
	getBootstrap(): Promise<boolean>;
	reset(): void;
}

export type StartResult = { ok: true } | { ok: false; reason: 'auth_failed' | 'connect_failed' };

export type ProtectConnectionDeps = {
	/** Factory for the (long-lived) ProtectApi. Receives the redacting logger. */
	apiFactory?: (logger: ProtectLogging) => ProtectApiLike;
	/** Logger injected into ProtectApi — scrubs payload-bearing args. */
	logger?: ProtectLogging;
	/** Injectable clock (ms). Defaults to Date.now. */
	now?: () => number;
	/** Backoff tuning (base/max/rng). */
	backoff?: BackoffOpts;
	/** Silence window for the watchdog. Defaults to DEFAULT_SILENCE_MS. */
	silenceMs?: number;
	/**
	 * Hard ceiling for a single connect()/getBootstrap() attempt. A controller that
	 * accepts the TCP connection but never finishes the bootstrap would otherwise
	 * wedge us in 'degraded' forever (B4). On timeout the attempt is treated as a
	 * failure → reconnect_failed → reschedule. Uses the injected timer so fake
	 * timers drive it. Defaults to 10s.
	 */
	connectTimeoutMs?: number;
};

type PacketListener = (packet: unknown) => void;
type StateListener = (state: ConnState) => void;

// A redacting logger: the lib logs `util.inspect(payload, depth:null)` on ws
// error, which would dump a full detection payload (presence PII) to journalctl.
// We DROP all variadic args and forward only a generic message string.
function makeRedactingLogger(): ProtectLogging {
	const safe = (message: string) => {
		// Intentionally swallow ...args (may contain raw payloads). One line, no payload.
		void message;
	};
	return {
		debug: (message: string) => safe(message),
		error: (message: string) => safe(message),
		info: (message: string) => safe(message),
		warn: (message: string) => safe(message)
	};
}

export class ProtectConnection extends EventEmitter {
	private readonly apiFactory: (logger: ProtectLogging) => ProtectApiLike;
	private readonly logger: ProtectLogging;
	private readonly now: () => number;
	private readonly backoff: BackoffOpts;
	private readonly silenceMs: number;
	private readonly connectTimeoutMs: number;

	private api: ProtectApiLike | null = null;
	private machine: ConnectionMachineState = { state: 'disconnected', attempt: 0 };
	private lastMessageAt = 0;
	private loggedIn = false;

	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	// In-flight reconnect guard (B4): exactly one connect()/getBootstrap() attempt
	// may run at a time. The watchdog tick and a stray scheduled attempt both check
	// this so a hanging getBootstrap() can never stack a second parallel attempt.
	private reconnecting = false;

	constructor(deps: ProtectConnectionDeps = {}) {
		super();
		this.logger = deps.logger ?? makeRedactingLogger();
		this.apiFactory = deps.apiFactory ?? ((log) => new ProtectApi(log) as unknown as ProtectApiLike);
		this.now = deps.now ?? Date.now;
		this.backoff = deps.backoff ?? {};
		this.silenceMs = deps.silenceMs ?? DEFAULT_SILENCE_MS;
		this.connectTimeoutMs = deps.connectTimeoutMs ?? 10_000;
	}

	// ── public API ─────────────────────────────────────────────────────────────

	getState(): ConnState {
		return this.machine.state;
	}

	/** Register a downstream consumer for decoded 'message' packets (pass-through). */
	onPacket(listener: PacketListener): void {
		this.on('packet', listener);
	}

	/** Subscribe to connection-state transitions. */
	onStateChange(listener: StateListener): void {
		this.on('state', listener);
	}

	async start(): Promise<StartResult> {
		this.stopped = false;
		// B2: the watchdog is the SOLE detector of a silent ws death (the lib emits no
		// close/error). Start it ONCE here and leave it running for the lifetime of the
		// connection — its tick body is state-gated (only acts while 'connected' and
		// not mid-reconnect), so it never needs to be torn down + re-armed per connect
		// (that churn is what could orphan recovery). Only stop() clears it.
		this.startWatchdog();

		const creds = await this.loadCreds();
		if (!creds) {
			// Tagged failure — mirror the bridge's "not configured" semantics without throwing.
			return { ok: false, reason: 'auth_failed' };
		}

		// First connect: no forceReset (no api/ws exists yet). Guard the in-flight flag
		// so the watchdog cannot race a reconnect against this initial attempt.
		this.reconnecting = true;
		let connected = false;
		try {
			connected = await this.connectWithTimeout(creds);
		} finally {
			this.reconnecting = false;
		}
		if (!connected) {
			// First connect failed → degrade + schedule a reconnect (the same recovery
			// path a later silent death takes). The always-on watchdog stays armed.
			this.transition('reconnect_failed');
			this.scheduleReconnect();
			return { ok: false, reason: 'connect_failed' };
		}
		return { ok: true };
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.reconnecting = false;
		this.clearReconnectTimer();
		this.clearWatchdog();
		if (this.api) {
			this.api.removeAllListeners();
			this.api.reset();
		}
		this.api = null;
		this.loggedIn = false;
		this.transition('stopped');
	}

	/**
	 * Signal that the ws was observed closed (the lib does not surface this as a
	 * reliable event, so the integration layer / watchdog calls this). Moves to
	 * 'degraded' and schedules a reconnect.
	 */
	notifyWsClosed(): void {
		if (this.stopped) return;
		this.transition('ws_closed');
		this.scheduleReconnect();
	}

	// ── internals ───────────────────────────────────────────────────────────────

	private async loadCreds(): Promise<{ host: string; username: string; password: string } | null> {
		const settings = await getSettings('unifi_');
		const host = settings.unifi_host;
		const username = settings.unifi_username;
		const password = settings.unifi_password;
		if (!host || !username || !password) return null;
		return { host, username, password };
	}

	/**
	 * Build (once) the long-lived api, login if needed, then getBootstrap (opens ws).
	 *
	 * @param forceReset On a RECONNECT we MUST call api.reset() before getBootstrap.
	 *   On a silent ws death the lib leaves `_eventsWs` set (it only nulls it on a real
	 *   close event, which never fires), so launchEventsWs() early-returns `true`
	 *   WITHOUT opening a fresh socket — a scheinerfolg that never re-establishes the
	 *   message stream (B1/B3). reset() closes + nulls `_eventsWs` (and `_bootstrap`)
	 *   so the next getBootstrap()→launchEventsWs() actually reopens the ws.
	 *   reset() does NOT clear auth cookies, so getBootstrap-first stays valid; we only
	 *   re-login if getBootstrap returns false (the existing false→fail path).
	 */
	private async connect(
		creds: { host: string; username: string; password: string },
		opts: { forceReset?: boolean } = {}
	): Promise<boolean> {
		if (!this.api) {
			this.api = this.apiFactory(this.logger);
			// Pass-through seam: re-emit decoded packets unmodified. NO classification,
			// NO payload logging. Every message also feeds the watchdog liveness clock.
			// NOTE: the lib emits ONLY login/bootstrap/message — NO 'close'/'error'
			// event ever fires, so a silently-dead ws surfaces no signal here. The
			// watchdog (time-since-last-message) is the SOLE silent-death detector.
			// (The lib still logs internally via the redacting logger above.)
			this.api.on('message', (packet: unknown) => {
				this.lastMessageAt = this.now();
				this.transition('message_received');
				this.emit('packet', packet);
			});
		} else if (opts.forceReset) {
			// B1/B3 — force the lib to drop a possibly-dead `_eventsWs` so the upcoming
			// getBootstrap()→launchEventsWs() opens a NEW socket instead of reusing a
			// silently-dead handle. MUST run BEFORE login/getBootstrap.
			this.api.reset();
		}

		if (!this.loggedIn) {
			const ok = await this.api.login(creds.host, creds.username, creds.password);
			if (!ok) return false;
			this.loggedIn = true;
		}

		// MANDATORY ordering: getBootstrap() FIRST (fresh lastUpdateId cursor), which
		// is also what (re)opens the ws as a side effect. Never reopen on a stale cursor.
		const bootstrapped = await this.api.getBootstrap();
		if (!bootstrapped) return false;

		// ws is now (re)open and cursor-fresh → connected. (The always-on watchdog is
		// already running from start(); we do NOT re-arm it here.)
		this.lastMessageAt = this.now();
		this.transition('ws_open');
		return true;
	}

	/**
	 * B4 — wrap a single connect() attempt in a hard timeout using the injected timer
	 * so a hanging login/getBootstrap cannot wedge recovery. Resolves false on timeout
	 * (treated as a failed attempt by the caller). Clears the timer on settle so no
	 * dangling timer survives into teardown.
	 */
	private connectWithTimeout(
		creds: { host: string; username: string; password: string },
		opts: { forceReset?: boolean } = {}
	): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve(false);
			}, this.connectTimeoutMs);
			(timer as { unref?: () => void }).unref?.();
			this.connect(creds, opts).then(
				(ok) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(ok);
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(false);
				}
			);
		});
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		this.clearReconnectTimer();
		const delay = computeBackoffMs(this.machine.attempt, this.backoff);
		this.reconnectTimer = setTimeout(() => {
			void this.attemptReconnect();
		}, delay);
	}

	private async attemptReconnect(): Promise<void> {
		if (this.stopped) return;
		// B4 — in-flight guard: never run two attempts at once. A watchdog tick or a
		// stray scheduled timer that fires while the first attempt awaits a (possibly
		// hanging) getBootstrap must NOT launch a second.
		if (this.reconnecting) return;
		this.reconnecting = true;
		try {
			const creds = await this.loadCreds();
			if (!creds) {
				// Creds vanished — degrade further and retry with larger backoff.
				this.transition('reconnect_failed');
				this.scheduleReconnect();
				return;
			}
			// B1/B3 — forceReset on every reconnect so a silently-dead `_eventsWs` is
			// dropped before getBootstrap()→launchEventsWs() reopens a fresh socket.
			// B4 — connectWithTimeout treats a hanging attempt as a failure → reschedule.
			const ok = await this.connectWithTimeout(creds, { forceReset: true });
			if (!ok) {
				this.transition('reconnect_failed');
				this.scheduleReconnect();
			}
			// On success, connect() already transitioned to 'connected'. The always-on
			// watchdog keeps running and re-arms its liveness window from lastMessageAt.
		} catch {
			this.transition('reconnect_failed');
			this.scheduleReconnect();
		} finally {
			this.reconnecting = false;
		}
	}

	private startWatchdog(): void {
		// Idempotent: never stack two intervals (start() may be called more than once).
		if (this.watchdogTimer) return;
		// Poll at a fraction of the silence window so we detect a dead ws within
		// ~one window. The predicate lives in the pure FSM module.
		const tick = Math.max(1000, Math.floor(this.silenceMs / 3));
		this.watchdogTimer = setInterval(() => {
			if (this.stopped) return;
			// State-gated: only ACT while genuinely 'connected'. While 'degraded'/
			// 'disconnected' a reconnect is already scheduled, so the tick is a no-op.
			if (this.machine.state !== 'connected') return;
			// In-flight guard (B4): do not stack a second attempt while one is awaiting.
			if (this.reconnecting) return;
			if (isSilentlyDead(this.lastMessageAt, this.now(), this.silenceMs)) {
				// ws presumed dead (no close event) → force a reconnect. We do NOT clear
				// the watchdog: it stays armed for the lifetime of the connection so a
				// FAILED reconnect can never orphan recovery (B2). scheduleReconnect →
				// attemptReconnect retries with backoff until 'connected' again.
				this.transition('watchdog_timeout');
				this.scheduleReconnect();
			}
		}, tick);
		// Do not keep the event loop alive solely for the watchdog (real timers only;
		// fake timers in tests have no unref()).
		(this.watchdogTimer as { unref?: () => void }).unref?.();
	}

	private clearWatchdog(): void {
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = null;
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/** Run an event through the pure reducer and emit 'state' on change. */
	private transition(event: ConnectionEvent): void {
		const prev = this.machine.state;
		this.machine = connectionReducer(this.machine, event);
		if (this.machine.state !== prev) {
			this.emit('state', this.machine.state);
		}
	}
}

// ── module-level singleton (lazy, long-lived — NOT TTL'd) ──────────────────────
let _connection: ProtectConnection | null = null;

/**
 * Lazy accessor for the process-wide long-lived connection. Deliberately has NO
 * TTL and is never reset by the settings/onboarding flow (unlike protect-bridge).
 */
export function getProtectConnection(): ProtectConnection {
	if (!_connection) {
		_connection = new ProtectConnection();
	}
	return _connection;
}
