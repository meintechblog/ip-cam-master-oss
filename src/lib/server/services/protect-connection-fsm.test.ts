// C1 ProtectConnection — Task 1: PURE state machine + backoff calculator (no I/O, no timers).
//
// These tests exercise the reconnect/watchdog DECISION logic deterministically.
// The fsm module must have zero imports from `unifi-protect` or `protect-bridge`.

import { describe, it, expect } from 'vitest';
import {
	computeBackoffMs,
	connectionReducer,
	isSilentlyDead,
	DEFAULT_SILENCE_MS,
	type ConnectionMachineState
} from './protect-connection-fsm';

describe('computeBackoffMs', () => {
	it('attempt 0 maps to ~baseMs (full-jitter upper bound = baseMs)', () => {
		// rng=()=>1 → floor(1 * base) but full jitter is floor(rng*delay); rng must be < 1 to stay < delay.
		// With rng just under 1 we land near the computed delay; with rng=0 we land at 0.
		expect(computeBackoffMs(0, { baseMs: 1000, maxMs: 30000, rng: () => 0 })).toBe(0);
		// Upper bound is the computed delay (base * 2^0 = 1000); jitter never exceeds it.
		expect(computeBackoffMs(0, { baseMs: 1000, maxMs: 30000, rng: () => 0.999999 })).toBeLessThanOrEqual(1000);
	});

	it('grows exponentially: delay ceiling = base * 2^attempt', () => {
		const nearOne = () => 0.999999;
		// attempt 1 → ceiling 2000, attempt 2 → 4000, attempt 3 → 8000
		expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 30000, rng: nearOne })).toBeLessThanOrEqual(2000);
		expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 30000, rng: nearOne })).toBeGreaterThan(1000);
		expect(computeBackoffMs(2, { baseMs: 1000, maxMs: 30000, rng: nearOne })).toBeLessThanOrEqual(4000);
		expect(computeBackoffMs(2, { baseMs: 1000, maxMs: 30000, rng: nearOne })).toBeGreaterThan(2000);
		expect(computeBackoffMs(3, { baseMs: 1000, maxMs: 30000, rng: nearOne })).toBeLessThanOrEqual(8000);
	});

	it('is capped at maxMs even for very high attempts and even with max jitter', () => {
		const nearOne = () => 0.999999;
		// base * 2^20 would be ~1 billion; cap to 30000.
		expect(computeBackoffMs(20, { baseMs: 1000, maxMs: 30000, rng: nearOne })).toBeLessThanOrEqual(30000);
		expect(computeBackoffMs(50, { baseMs: 1000, maxMs: 30000, rng: nearOne })).toBeLessThanOrEqual(30000);
	});

	it('full jitter: repeated calls for the same attempt land within [0, ceiling] and are not all identical', () => {
		const opts = { baseMs: 1000, maxMs: 30000 }; // default Math.random rng
		const samples = Array.from({ length: 40 }, () => computeBackoffMs(4, opts)); // ceiling = 16000
		for (const s of samples) {
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(16000);
		}
		const unique = new Set(samples);
		expect(unique.size).toBeGreaterThan(1); // jitter is real, not constant
	});

	it('uses sane defaults (base 1000, max 30000) when opts omitted', () => {
		const v = computeBackoffMs(0); // default rng = Math.random
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThanOrEqual(1000);
		// high attempt with defaults still capped at 30000
		expect(computeBackoffMs(40)).toBeLessThanOrEqual(30000);
	});
});

describe('connectionReducer', () => {
	const fresh: ConnectionMachineState = { state: 'disconnected', attempt: 0 };

	it("'ws_open' → connected and resets attempt to 0", () => {
		const degraded: ConnectionMachineState = { state: 'degraded', attempt: 5 };
		const next = connectionReducer(degraded, 'ws_open');
		expect(next.state).toBe('connected');
		expect(next.attempt).toBe(0);
	});

	it("'ws_closed' from connected → degraded, attempt increments", () => {
		const connected: ConnectionMachineState = { state: 'connected', attempt: 0 };
		const next = connectionReducer(connected, 'ws_closed');
		expect(next.state).toBe('degraded');
		expect(next.attempt).toBe(1);
	});

	it("'watchdog_timeout' from connected → degraded, attempt increments", () => {
		const connected: ConnectionMachineState = { state: 'connected', attempt: 0 };
		const next = connectionReducer(connected, 'watchdog_timeout');
		expect(next.state).toBe('degraded');
		expect(next.attempt).toBe(1);
	});

	it("'reconnect_failed' from degraded → stays degraded, attempt increments (drives larger backoff)", () => {
		const degraded: ConnectionMachineState = { state: 'degraded', attempt: 2 };
		const next = connectionReducer(degraded, 'reconnect_failed');
		expect(next.state).toBe('degraded');
		expect(next.attempt).toBe(3);
	});

	it("'stopped' → disconnected, attempt reset to 0", () => {
		const connected: ConnectionMachineState = { state: 'connected', attempt: 7 };
		const next = connectionReducer(connected, 'stopped');
		expect(next.state).toBe('disconnected');
		expect(next.attempt).toBe(0);
	});

	it("'message_received' while connected → stays connected, attempt unchanged", () => {
		const connected: ConnectionMachineState = { state: 'connected', attempt: 0 };
		const next = connectionReducer(connected, 'message_received');
		expect(next.state).toBe('connected');
		expect(next.attempt).toBe(0);
	});

	it('is a pure function — does not mutate the input state', () => {
		const input: ConnectionMachineState = { state: 'connected', attempt: 0 };
		connectionReducer(input, 'ws_closed');
		expect(input).toEqual({ state: 'connected', attempt: 0 });
	});

	it('starting from a fresh disconnected state, ws_open connects', () => {
		const next = connectionReducer(fresh, 'ws_open');
		expect(next.state).toBe('connected');
		expect(next.attempt).toBe(0);
	});
});

describe('isSilentlyDead', () => {
	it('returns true when now - lastMessageAt >= silenceMs', () => {
		expect(isSilentlyDead(1000, 1000 + 90_000, 90_000)).toBe(true);
		expect(isSilentlyDead(1000, 1000 + 90_001, 90_000)).toBe(true);
	});

	it('returns false when the gap is below the silence window', () => {
		expect(isSilentlyDead(1000, 1000 + 89_999, 90_000)).toBe(false);
		expect(isSilentlyDead(1000, 1000, 90_000)).toBe(false);
	});
});

describe('DEFAULT_SILENCE_MS', () => {
	it('is 90 seconds', () => {
		expect(DEFAULT_SILENCE_MS).toBe(90_000);
	});
});
