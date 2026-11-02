// C1 ProtectConnection — PURE reconnect/watchdog decision logic.
//
// This module is deliberately I/O-free and timer-free: it owns ONLY the decision
// arithmetic (backoff delay, state transitions, silence predicate) so the manager
// in `protect-connection.ts` can wire real timers / a real ProtectApi around it
// while the hard-to-reproduce edge cases stay unit-testable and deterministic.
//
// HARD CONSTRAINT: no imports from `unifi-protect` or `protect-bridge` here.
// There are no decoded payloads at this layer, so there is nothing to redact.

/** Normalized, observable connection state surfaced to downstream consumers. */
export type ConnState = 'connected' | 'degraded' | 'disconnected';

/** Minimal machine state: where we are + how many failed attempts (drives backoff). */
export type ConnectionMachineState = {
	state: ConnState;
	attempt: number;
};

/** Events that drive the connection state machine. */
export type ConnectionEvent =
	| 'ws_open' // bootstrap ok + ws (re)opened → healthy
	| 'ws_closed' // ws close observed → needs reconnect
	| 'watchdog_timeout' // no message within silence window → ws presumed dead
	| 'reconnect_failed' // a reconnect attempt did not reach ws_open
	| 'message_received' // a 'message' packet arrived (liveness signal)
	| 'stopped'; // explicit teardown

export type BackoffOpts = {
	baseMs?: number;
	maxMs?: number;
	rng?: () => number;
};

/**
 * Full-jitter exponential backoff (AWS "Exponential Backoff And Jitter").
 *
 * ceiling = min(maxMs, baseMs * 2^attempt); the returned delay is a uniform
 * random pick in [0, ceiling) via `floor(rng() * ceiling)`. Full jitter is what
 * de-correlates many clients (and many reconnect loops) so they do not all
 * re-hit the controller on the same beat — directly mitigating a reconnect storm.
 */
export function computeBackoffMs(attempt: number, opts: BackoffOpts = {}): number {
	const baseMs = opts.baseMs ?? 1000;
	const maxMs = opts.maxMs ?? 30_000;
	const rng = opts.rng ?? Math.random;

	// 2^attempt can overflow into Infinity for large attempts; Math.min folds it to maxMs.
	const ceiling = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
	return Math.floor(rng() * ceiling);
}

/**
 * Pure transition function over the connection machine. Never mutates `state`.
 *
 * - `ws_open` and `stopped` reset the attempt counter (a clean baseline).
 * - The failure/degrade events increment `attempt` so the next backoff is larger.
 * - `message_received` is a no-op for the machine here; the timer reset it implies
 *   lives in the manager (Task 2). Keeping it pure means a stray message can never
 *   accidentally change the reported state.
 */
export function connectionReducer(
	state: ConnectionMachineState,
	event: ConnectionEvent
): ConnectionMachineState {
	switch (event) {
		case 'ws_open':
			return { state: 'connected', attempt: 0 };
		case 'ws_closed':
		case 'watchdog_timeout':
		case 'reconnect_failed':
			return { state: 'degraded', attempt: state.attempt + 1 };
		case 'message_received':
			return { state: state.state, attempt: state.attempt };
		case 'stopped':
			return { state: 'disconnected', attempt: 0 };
		default: {
			// Exhaustiveness guard — a new event must be handled explicitly.
			const _never: never = event;
			return state ?? _never;
		}
	}
}

/** Liveness predicate: the ws is presumed dead once silence reaches the window. */
export function isSilentlyDead(lastMessageAt: number, now: number, silenceMs: number): boolean {
	return now - lastMessageAt >= silenceMs;
}

// Protect emits frequent keepalive/system packets (well under a minute even when
// idle), so 90s is comfortably above the normal inter-message gap yet detects a
// dead ws within ~1.5 min — fast enough to recover before downstream consumers
// misread silence as "all clear", without flapping on a brief lull.
export const DEFAULT_SILENCE_MS = 90_000;
