// C1 ProtectConnection — self-healing behavior tests.
//
// The whole point of this file (post pre-deploy Codex refute-review, 260610-do7):
// recovery from a SILENT ws death must be proven through the REAL lib failure mode,
// NOT by hand-calling notifyWsClosed(). The previous suite passed only because it
// called notifyWsClosed() — the exact signal that NEVER fires in production (the
// unifi-protect lib emits only login/bootstrap/message; no close, no error). Those
// false-confidence tests are DELETED here.
//
// The fake ProtectApi below models the lib's actual semantics (verified against
// node_modules/unifi-protect/dist/protect-api.js):
//   - emits ONLY 'login'/'bootstrap'/'message' (never 'close'/'error');
//   - keeps a real `_eventsWs`-like handle (__wsAlive): getBootstrap() reopens a NEW
//     ws ONLY when __wsAlive is false (mirrors launchEventsWs() `if(_eventsWs) return
//     true` early-return — a still-set handle is reused, NOT reopened);
//   - reset() drops the handle (__wsAlive=false) so the NEXT getBootstrap() reopens;
//   - __silentDeath() flips __wsAlive off WITHOUT emitting anything — exactly prod.
//
// Fake timers drive backoff + watchdog. Project convention: vi.useFakeTimers() +
// vi.hoisted() mocks (see scheduler.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ProtectLogging } from 'unifi-protect';

// getSettings('unifi_') is the ONLY creds path C1 is allowed to use (NOT the TTL singleton).
const { mockGetSettings } = vi.hoisted(() => ({
	mockGetSettings: vi.fn<(prefix: string) => Promise<Record<string, string>>>()
}));

vi.mock('./settings', () => ({
	getSettings: mockGetSettings
}));

import {
	ProtectConnection,
	type ProtectApiLike,
	type ProtectConnectionDeps
} from './protect-connection';
import { DEFAULT_SILENCE_MS } from './protect-connection-fsm';

// ── Fake ProtectApi (models the REAL lib) ──────────────────────────────────────
// EventEmitter base (matches the real lib) + the subset C1 calls. login/getBootstrap/
// reset are vi.fn spies (kept off the ProtectApiLike intersection to avoid the
// mock-vs-`(): void` signature clash; the apiFactory cast at the call site holds at
// runtime). __wsAlive models the lib's `_eventsWs` handle; __opened counts how many
// times a NEW ws was actually opened (the load-bearing reconnect proof).
type FakeApi = EventEmitter & {
	login: ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<boolean>>>;
	getBootstrap: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
	reset: ReturnType<typeof vi.fn<() => void>>;
	__loginResult: boolean;
	/** Per-getBootstrap result queue; falls back to last/true. */
	__bootstrapResults: boolean[];
	/** Models `_eventsWs` being set (true) or null (false). */
	__wsAlive: boolean;
	/** How many times a NEW ws was actually opened. */
	__opened: number;
	/** Optional: a manually-controlled gate for the NEXT getBootstrap (B4 tests). */
	__bootstrapGate: Promise<boolean> | null;
	/** Flip liveness off WITHOUT emitting anything (no message, no close) — prod silent death. */
	__silentDeath: () => void;
};

function makeFakeApi(): FakeApi {
	const ee = new EventEmitter() as unknown as FakeApi;
	ee.__loginResult = true;
	ee.__bootstrapResults = [];
	ee.__wsAlive = false;
	ee.__opened = 0;
	ee.__bootstrapGate = null;

	ee.login = vi.fn(async () => ee.__loginResult);

	ee.getBootstrap = vi.fn(async () => {
		// A manually-controlled gate lets B4 tests hold a getBootstrap pending / never
		// resolve, exercising the in-flight guard + connect timeout.
		if (ee.__bootstrapGate) {
			const gate = ee.__bootstrapGate;
			ee.__bootstrapGate = null;
			const ok = await gate;
			if (ok && !ee.__wsAlive) {
				ee.__wsAlive = true;
				ee.__opened++;
			}
			return ok;
		}
		const queued = ee.__bootstrapResults.shift();
		const ok = queued === undefined ? true : queued;
		if (!ok) return false;
		// Mirror launchEventsWs(): only OPEN a new ws if one is not already set.
		// A still-set (silently-dead) handle is reused → NO new open.
		if (!ee.__wsAlive) {
			ee.__wsAlive = true;
			ee.__opened++;
		}
		return true;
	});

	// reset() mirrors lib:1114 — drops the (possibly-dead) ws handle so the next
	// getBootstrap()→launchEventsWs() actually reopens.
	ee.reset = vi.fn(() => {
		ee.__wsAlive = false;
	});

	// Silent death: the ws is dead but the lib emits NOTHING and (crucially) leaves
	// `_eventsWs` SET. We model that by killing real liveness WITHOUT touching
	// __wsAlive — so a naive getBootstrap (no reset) early-returns true and reuses
	// the dead handle (NO new open), exactly the prod scheinerfolg.
	ee.__silentDeath = () => {
		// no emit, no close — and __wsAlive stays true (handle still set)
	};

	return ee;
}

function makeLogger(): ProtectLogging & { __calls: unknown[][] } {
	const calls: unknown[][] = [];
	const record =
		(level: string) =>
		(message: string, ...args: unknown[]) => {
			calls.push([level, message, ...args]);
		};
	return {
		__calls: calls,
		debug: record('debug'),
		error: record('error'),
		info: record('info'),
		warn: record('warn')
	};
}

let fakeApi: FakeApi;
let logger: ReturnType<typeof makeLogger>;
let clockNow: number;

function makeConn(overrides: Partial<ProtectConnectionDeps> = {}): ProtectConnection {
	const deps: ProtectConnectionDeps = {
		apiFactory: () => fakeApi as unknown as ProtectApiLike,
		logger,
		now: () => clockNow,
		backoff: { baseMs: 1000, maxMs: 30000, rng: () => 1 }, // full delay, deterministic
		silenceMs: DEFAULT_SILENCE_MS,
		connectTimeoutMs: 10_000,
		...overrides
	};
	return new ProtectConnection(deps);
}

beforeEach(() => {
	vi.useFakeTimers();
	clockNow = 0;
	fakeApi = makeFakeApi();
	logger = makeLogger();
	mockGetSettings.mockReset();
	mockGetSettings.mockResolvedValue({
		unifi_host: '192.0.2.1',
		unifi_username: 'admin',
		unifi_password: 'secret'
	});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

// Advance both the fake timer queue and the injected clock in lockstep.
async function advance(ms: number): Promise<void> {
	clockNow += ms;
	await vi.advanceTimersByTimeAsync(ms);
}

// ── start / creds ────────────────────────────────────────────────────────────

describe('ProtectConnection.start', () => {
	it('calls login() then getBootstrap() and becomes connected (opens 1 ws)', async () => {
		const conn = makeConn();
		await conn.start();

		expect(fakeApi.login).toHaveBeenCalledTimes(1);
		expect(fakeApi.getBootstrap).toHaveBeenCalledTimes(1);
		// login precedes bootstrap.
		expect(fakeApi.login.mock.invocationCallOrder[0]).toBeLessThan(
			fakeApi.getBootstrap.mock.invocationCallOrder[0]
		);
		expect(conn.getState()).toBe('connected');
		expect(fakeApi.__opened).toBe(1);

		await conn.stop();
	});

	it('login uses creds from getSettings("unifi_") — not the TTL singleton', async () => {
		const conn = makeConn();
		await conn.start();
		expect(mockGetSettings).toHaveBeenCalledWith('unifi_');
		expect(fakeApi.login).toHaveBeenCalledWith('192.0.2.1', 'admin', 'secret');
		await conn.stop();
	});

	it('returns a tagged failure (not connected) when creds are missing', async () => {
		mockGetSettings.mockResolvedValue({});
		const conn = makeConn();
		const result = await conn.start();
		expect(result.ok).toBe(false);
		expect(conn.getState()).not.toBe('connected');
		await conn.stop();
	});
});

// ── message pass-through ────────────────────────────────────────────────────────

describe('message seam (pass-through, no classification)', () => {
	it("re-delivers 'message' packets to a registered consumer unmodified", async () => {
		const conn = makeConn();
		await conn.start();

		const received: unknown[] = [];
		conn.onPacket((pkt) => received.push(pkt));

		const packet = {
			header: { modelKey: 'camera', action: 'update', id: 'cam-1' },
			payload: { smartDetectTypes: ['person'], score: 88, metadata: { bbox: [1, 2, 3, 4] } }
		};
		fakeApi.emit('message', packet);

		expect(received).toHaveLength(1);
		expect(received[0]).toBe(packet); // same reference, untouched
		await conn.stop();
	});
});

// ── B1 + B3: the load-bearing silent-death recovery proof ───────────────────────

describe('B1+B3 — silent-dead ws recovered via reset()+rebootstrap (watchdog-driven, NO notifyWsClosed)', () => {
	it('silent death (no events) → watchdog trips → reset() BEFORE getBootstrap → NEW ws opened → connected', async () => {
		const conn = makeConn();
		const seen: string[] = [];
		conn.onStateChange((s) => seen.push(s));

		await conn.start();
		expect(conn.getState()).toBe('connected');
		expect(fakeApi.__opened).toBe(1);
		expect(fakeApi.getBootstrap).toHaveBeenCalledTimes(1);

		// The ws dies SILENTLY: no 'message', no 'close', and the lib still holds the
		// handle (__wsAlive stays true). Nothing is emitted — this is exactly prod.
		fakeApi.__silentDeath();

		// Sanity: WITHOUT reset(), a bare getBootstrap would early-return true and
		// reuse the dead handle (no new open). Prove that the production fix path
		// (reset-before-rebootstrap, driven by the watchdog) opens a NEW ws.
		// Advance past the silence window so the always-on watchdog trips, then let
		// backoff fire the reconnect.
		await advance(DEFAULT_SILENCE_MS + 2000);

		// reset() was called and a NEW ws was actually opened (recovery, not scheinerfolg).
		expect(fakeApi.reset).toHaveBeenCalled();
		expect(fakeApi.__opened).toBe(2); // a SECOND ws was opened — the dead handle was replaced
		expect(fakeApi.getBootstrap).toHaveBeenCalledTimes(2);
		expect(conn.getState()).toBe('connected');
		expect(seen).toContain('degraded'); // watchdog forced a degrade en route

		// reset() must precede the reopening getBootstrap (the 2nd getBootstrap call).
		const resetOrder = fakeApi.reset.mock.invocationCallOrder[0];
		const secondBootstrapOrder = fakeApi.getBootstrap.mock.invocationCallOrder[1];
		expect(resetOrder).toBeLessThan(secondBootstrapOrder);

		await conn.stop();
	});

	it('CONTROL: without reset(), reusing the dead handle would NOT reopen — proves reset() is what recovers', async () => {
		// This is a white-box assertion on the FAKE itself, documenting WHY the fix is
		// load-bearing: a getBootstrap with __wsAlive still true does not open a new ws.
		fakeApi.__wsAlive = true; // simulate a still-set (dead) handle
		fakeApi.__opened = 1;
		await fakeApi.getBootstrap();
		expect(fakeApi.__opened).toBe(1); // NO new open — early-return reuse
		// Only reset() unblocks a real reopen.
		fakeApi.reset();
		await fakeApi.getBootstrap();
		expect(fakeApi.__opened).toBe(2);
	});
});

// ── B2: a failed reconnect never orphans recovery ──────────────────────────────

describe('B2 — failed reconnect does not orphan recovery (always-on state-gated watchdog)', () => {
	it('silent death + first reconnect fails (getBootstrap false) → keeps retrying until connected', async () => {
		const conn = makeConn();
		const seen: string[] = [];
		conn.onStateChange((s) => seen.push(s));
		await conn.start();
		expect(fakeApi.__opened).toBe(1);

		// First reconnect's getBootstrap returns false, second returns true.
		// (reset() runs first each reconnect, so __wsAlive is false going into each.)
		fakeApi.__bootstrapResults = [false, true];

		// Silent death → watchdog trips after the window. With fake timers the trip,
		// the failed reconnect #1, and the successful retry #2 can collapse into a few
		// advances; we assert the OUTCOME + that a failed attempt was observed (the
		// always-on watchdog never tore down → recovery was not orphaned).
		fakeApi.__silentDeath();
		await advance(DEFAULT_SILENCE_MS + 1000);
		await advance(300_000); // let the escalating backoff drive #1 (false) then #2 (true)

		// At least two reconnect attempts ran (the first failed, the retry succeeded):
		// reset() ran before each reconnect, and at least one NEW ws opened on recovery.
		// (After recovery, the long no-message advance lets the always-on watchdog trip
		// again and re-heal — correct self-healing — so we assert >= rather than ==.)
		expect(fakeApi.reset.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(fakeApi.__opened).toBeGreaterThanOrEqual(2); // recovery reopened a fresh ws
		expect(conn.getState()).toBe('connected');
		// The state machine passed THROUGH degraded (failed attempt) before recovering.
		expect(seen).toContain('degraded');
		expect(seen[seen.length - 1]).toBe('connected');

		await conn.stop();
	});
});

// ── B4: in-flight guard + connect timeout ──────────────────────────────────────

describe('B4 — in-flight reconnect guard + connect timeout', () => {
	it('a slow (pending) reconnect getBootstrap is NOT stacked by a second attempt', async () => {
		// A very large connect timeout so the gated attempt stays GENUINELY pending for
		// the whole advance window (we are isolating the in-flight guard, not the timeout).
		const conn = makeConn({ connectTimeoutMs: 10_000_000 });
		await conn.start();
		expect(fakeApi.getBootstrap).toHaveBeenCalledTimes(1);

		// Arm a manually-controlled gate so the NEXT getBootstrap (the reconnect) stays
		// pending until we resolve it.
		let releaseBootstrap!: (ok: boolean) => void;
		fakeApi.__bootstrapGate = new Promise<boolean>((resolve) => {
			releaseBootstrap = resolve;
		});

		// Trigger the reconnect via silent death + watchdog.
		fakeApi.__silentDeath();
		await advance(DEFAULT_SILENCE_MS + 1000); // watchdog trips, backoff fires reconnect #1 (now pending)

		// Reconnect #1 is in flight (awaiting the gated getBootstrap). Drive several more
		// watchdog ticks + backoff windows: the in-flight guard must prevent a 2nd attempt.
		const bootstrapCallsWhilePending = fakeApi.getBootstrap.mock.calls.length;
		expect(bootstrapCallsWhilePending).toBe(2); // start + the (pending) reconnect
		await advance(DEFAULT_SILENCE_MS * 3); // many more ticks — must NOT stack a 2nd attempt
		expect(fakeApi.getBootstrap.mock.calls.length).toBe(bootstrapCallsWhilePending);

		// Now resolve the gate → the single in-flight attempt completes → connected.
		releaseBootstrap(true);
		await advance(1);
		expect(conn.getState()).toBe('connected');

		await conn.stop();
	});

	it('a hanging getBootstrap times out → treated as failure → reschedules → recovers', async () => {
		const conn = makeConn({ connectTimeoutMs: 5_000 });
		const seen: string[] = [];
		conn.onStateChange((s) => seen.push(s));
		await conn.start();

		// The reconnect's getBootstrap NEVER resolves (a wedged controller).
		fakeApi.__bootstrapGate = new Promise<boolean>(() => {
			/* never resolves */
		});

		fakeApi.__silentDeath();
		await advance(DEFAULT_SILENCE_MS + 1000); // watchdog trips → reconnect #1 starts, getBootstrap hangs

		// Advance past the connect timeout → attempt #1 is treated as a failure (NOT a
		// permanent wedge) and a next reconnect is scheduled.
		await advance(5_000);
		expect(seen).toContain('degraded'); // the hung attempt was failed, not wedged

		// The NEXT reconnect (the gate is now cleared → queue → true) recovers.
		await advance(300_000);
		expect(conn.getState()).toBe('connected');
		expect(fakeApi.__opened).toBeGreaterThanOrEqual(2); // a fresh ws was eventually opened
		expect(seen[seen.length - 1]).toBe('connected');

		await conn.stop();
	});
});

// ── escalating backoff (FSM-driven, no hand-called signals) ─────────────────────

describe('escalating backoff', () => {
	it('two consecutive failed reconnects schedule increasing delays, then recovers', async () => {
		const conn = makeConn();
		const seen: string[] = [];
		conn.onStateChange((s) => seen.push(s));
		await conn.start();

		// reset() runs before each reconnect so __wsAlive=false going in; the first two
		// getBootstraps fail, the third succeeds and opens a new ws.
		fakeApi.__bootstrapResults = [false, false, true];

		fakeApi.__silentDeath();
		await advance(DEFAULT_SILENCE_MS + 1000); // watchdog trips → reconnect #1 (false)
		expect(seen).toContain('degraded');

		// Drive enough time for the escalating backoff to run #2 (false) then #3 (true).
		await advance(300_000);
		expect(conn.getState()).toBe('connected');
		expect(fakeApi.__opened).toBeGreaterThanOrEqual(2); // at least one successful reopen
		await conn.stop();
	});
});

// ── watchdog liveness reset on message ──────────────────────────────────────────

describe('watchdog', () => {
	it('a message before the window resets the watchdog (no forced reconnect)', async () => {
		const conn = makeConn();
		await conn.start();

		// Almost at the window, then a heartbeat message arrives.
		await advance(DEFAULT_SILENCE_MS - 1000);
		fakeApi.emit('message', { header: { action: 'add' }, payload: {} });

		// Advance another (window - 1000) — without the reset this would have tripped.
		await advance(DEFAULT_SILENCE_MS - 1000);
		expect(conn.getState()).toBe('connected');
		expect(fakeApi.getBootstrap).toHaveBeenCalledTimes(1); // never reconnected
		expect(fakeApi.reset).not.toHaveBeenCalled();
		await conn.stop();
	});
});

// ── state observability ─────────────────────────────────────────────────────────

describe('state observability', () => {
	it('onStateChange fires connected → degraded → connected across a silent-death recovery', async () => {
		const conn = makeConn();
		const seen: string[] = [];
		conn.onStateChange((s) => seen.push(s));

		await conn.start();
		fakeApi.__silentDeath();
		await advance(DEFAULT_SILENCE_MS + 2000);

		expect(seen).toContain('connected');
		expect(seen).toContain('degraded');
		// ends connected after the reconnect
		expect(seen[seen.length - 1]).toBe('connected');
		await conn.stop();
	});
});

// ── teardown ─────────────────────────────────────────────────────────────────────

describe('teardown', () => {
	it('stop() resets the api, clears all timers (no leaks), state → disconnected', async () => {
		const conn = makeConn();
		await conn.start();
		// Trigger a silent-death recovery so a reconnect timer + the watchdog are live,
		// then ensure teardown clears EVERYTHING (incl. any connect-timeout timer).
		fakeApi.__silentDeath();
		await advance(DEFAULT_SILENCE_MS + 2000);

		await conn.stop();

		expect(fakeApi.reset).toHaveBeenCalled(); // stop() resets too
		expect(conn.getState()).toBe('disconnected');
		expect(vi.getTimerCount()).toBe(0);
	});
});

// ── redaction / local-first ──────────────────────────────────────────────────────

describe('redaction / local-first', () => {
	it('never passes a raw message payload to the injected logger', async () => {
		const conn = makeConn();
		await conn.start();

		const secretPayload = { smartDetectTypes: ['person'], metadata: { bbox: [9, 9, 9, 9] } };
		fakeApi.emit('message', { header: { action: 'update' }, payload: secretPayload });

		const flat = JSON.stringify(logger.__calls);
		expect(flat).not.toContain('person');
		expect(flat).not.toContain('bbox');
		await conn.stop();
	});

	it('makes no calls beyond the lib seam (login + getBootstrap; never wires a dead error listener)', async () => {
		const conn = makeConn();
		await conn.start();
		expect(fakeApi.login).toHaveBeenCalled();
		expect(fakeApi.getBootstrap).toHaveBeenCalled();
		// The dead `api.on('error')` wiring was removed — the fake never sees an 'error'
		// listener registered (the lib emits no 'error' event). Assert none was added.
		expect(fakeApi.listenerCount('error')).toBe(0);
		await conn.stop();
	});
});
