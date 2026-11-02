// v1.3 Phase 21 Plan 04 — fake-timer tests for ws-manager.
//
// Covers HUB-RCN-07: backoff schedule [5,10,30,60,120,300]s with cap,
// single-flight reconnect, _attempt reset on success, stopWs cancellation,
// resetProtectClient called on stop, and a regression guard locking the
// schedule constant.
//
// Pattern S-6 (singleton with module-scoped state) means each test must
// `vi.resetModules()` to get a fresh ws-manager instance. Without that,
// state leaks between tests because module-level `_attempt` etc. persist.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// ────────────────────────────────────────────────────────────────────────────
// Hoisted mocks — required so the vi.mock(...) factories can reference them.
// ────────────────────────────────────────────────────────────────────────────
const { mockGetProtectClient, mockResetProtectClient, mockReconcile, selectGet, mockBridgeRow } =
	vi.hoisted(() => ({
		mockGetProtectClient: vi.fn(),
		mockResetProtectClient: vi.fn(),
		mockReconcile: vi.fn(),
		selectGet: vi.fn(),
		mockBridgeRow: {
			id: 1,
			vmid: 2014,
			hostname: 'bridge',
			containerIp: '192.0.2.139',
			status: 'running'
		}
	}));

vi.mock('$lib/server/services/protect-bridge', () => ({
	getProtectClient: mockGetProtectClient,
	resetProtectClient: mockResetProtectClient
}));

vi.mock('./reconcile', () => ({
	reconcile: mockReconcile
}));

vi.mock('$lib/server/db/client', () => ({
	db: { select: () => ({ from: () => ({ get: selectGet }) }) }
}));

vi.mock('$lib/server/db/schema', () => ({
	protectHubBridges: {}
}));

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
type Handler = (arg: unknown) => void;

interface MockClient {
	getBootstrap: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	__emit: (event: string, arg: unknown) => void;
}

const makeClient = (): MockClient => {
	const handlers: Record<string, Handler[]> = {};
	return {
		getBootstrap: vi.fn(),
		on: vi.fn((event: string, fn: Handler) => {
			handlers[event] = handlers[event] ?? [];
			handlers[event].push(fn);
		}),
		__emit: (event: string, arg: unknown) => {
			(handlers[event] ?? []).forEach((fn) => fn(arg));
		}
	};
};

// ────────────────────────────────────────────────────────────────────────────
// Per-test fresh-module loading + state cleanup
// ────────────────────────────────────────────────────────────────────────────
let startWs: typeof import('./ws-manager').startWs;
let stopWs: typeof import('./ws-manager').stopWs;
let BACKOFF_SCHEDULE_MS: typeof import('./ws-manager').BACKOFF_SCHEDULE_MS;

describe('ws-manager (HUB-RCN-07)', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-06T13:00:00Z'));

		// Default behaviour: bridge row present, reconcile resolves OK.
		selectGet.mockReturnValue(mockBridgeRow);
		mockReconcile.mockResolvedValue({
			ok: true,
			status: 'success',
			reconcileId: 'test-id',
			hashChanged: true,
			newHash: 'h',
			outputCount: 0
		});

		const mod = await import('./ws-manager');
		startWs = mod.startWs;
		stopWs = mod.stopWs;
		BACKOFF_SCHEDULE_MS = mod.BACKOFF_SCHEDULE_MS;
	});

	afterEach(() => {
		// Best-effort module-state cleanup so timers from a leaked test do not
		// bleed into the next case.
		stopWs();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('BACKOFF_SCHEDULE_MS regression guard — locked tuple [5,10,30,60,120,300]s', () => {
		expect(BACKOFF_SCHEDULE_MS).toEqual([5_000, 10_000, 30_000, 60_000, 120_000, 300_000]);
	});

	it('1st failure → next attempt at +5000ms (boundary check)', async () => {
		const client = makeClient();
		client.getBootstrap.mockResolvedValueOnce(false); // 1st attempt fails
		client.getBootstrap.mockResolvedValueOnce(true); // 2nd attempt succeeds
		mockGetProtectClient.mockResolvedValue(client);

		await startWs();
		expect(client.getBootstrap).toHaveBeenCalledTimes(1);

		// 4999ms — must NOT have fired yet
		await vi.advanceTimersByTimeAsync(4_999);
		expect(client.getBootstrap).toHaveBeenCalledTimes(1);

		// +1ms more (5000ms total) — second attempt fires
		await vi.advanceTimersByTimeAsync(1);
		expect(client.getBootstrap).toHaveBeenCalledTimes(2);
	});

	it('backoff cadence — 1→5s, 2→10s, 3→30s, 4→60s, 5→120s, 6→300s', async () => {
		const client = makeClient();
		// Six failures in a row, then a success to halt the chain
		for (let i = 0; i < 6; i++) client.getBootstrap.mockResolvedValueOnce(false);
		client.getBootstrap.mockResolvedValueOnce(true);
		mockGetProtectClient.mockResolvedValue(client);

		await startWs();
		expect(client.getBootstrap).toHaveBeenCalledTimes(1);

		const expectedDelays = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
		for (let i = 0; i < expectedDelays.length; i++) {
			await vi.advanceTimersByTimeAsync(expectedDelays[i]);
			expect(client.getBootstrap).toHaveBeenCalledTimes(i + 2);
		}
	});

	it('cap — 7th failure still uses 300_000ms (clamp at last index)', async () => {
		const client = makeClient();
		// Seven failures in a row
		for (let i = 0; i < 7; i++) client.getBootstrap.mockResolvedValueOnce(false);
		client.getBootstrap.mockResolvedValueOnce(true);
		mockGetProtectClient.mockResolvedValue(client);

		await startWs();
		// Burn through the first 6 backoffs
		const cumulative = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
		for (const d of cumulative) await vi.advanceTimersByTimeAsync(d);
		expect(client.getBootstrap).toHaveBeenCalledTimes(7); // 1 initial + 6 retries

		// 7th retry — must also be 300_000ms (clamped to last entry)
		await vi.advanceTimersByTimeAsync(299_999);
		expect(client.getBootstrap).toHaveBeenCalledTimes(7);
		await vi.advanceTimersByTimeAsync(1);
		expect(client.getBootstrap).toHaveBeenCalledTimes(8);
	});

	it('single-flight — concurrent disconnect + login(false) coalesce into one timer', async () => {
		const client = makeClient();
		client.getBootstrap.mockResolvedValueOnce(true); // 1st attempt OK → installs login listener
		client.getBootstrap.mockResolvedValueOnce(true); // future reconnect attempt
		mockGetProtectClient.mockResolvedValue(client);

		await startWs();
		expect(client.getBootstrap).toHaveBeenCalledTimes(1);
		// At this point no reconnect timer should be scheduled.
		expect(vi.getTimerCount()).toBe(0);

		// Fire two login(false) events back-to-back — second one MUST be coalesced.
		client.__emit('login', false);
		client.__emit('login', false);
		expect(vi.getTimerCount()).toBe(1);

		// Drain the single timer; getBootstrap fires once more, not twice.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(client.getBootstrap).toHaveBeenCalledTimes(2);
	});

	it('on success — _attempt resets AND reconcile(bridgeId, ws_reconnect) called exactly once', async () => {
		const client = makeClient();
		client.getBootstrap.mockResolvedValueOnce(false); // 1st fails
		client.getBootstrap.mockResolvedValueOnce(true); // 2nd succeeds
		mockGetProtectClient.mockResolvedValue(client);

		await startWs();
		expect(mockReconcile).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5_000);

		// Flush any pending microtasks so the reconcile call is visible.
		await vi.runAllTimersAsync();

		expect(mockReconcile).toHaveBeenCalledTimes(1);
		expect(mockReconcile).toHaveBeenCalledWith(1, 'ws_reconnect');
	});

	it('on success after multiple failures — _attempt counter resets to 0', async () => {
		const client = makeClient();
		client.getBootstrap.mockResolvedValueOnce(false); // attempt 1: fail (delay [0]=5s)
		client.getBootstrap.mockResolvedValueOnce(false); // attempt 2: fail (delay [1]=10s)
		client.getBootstrap.mockResolvedValueOnce(false); // attempt 3: fail (delay [2]=30s)
		client.getBootstrap.mockResolvedValueOnce(true); // attempt 4: success → _attempt resets
		client.getBootstrap.mockResolvedValueOnce(true); // attempt 5: success after disconnect
		mockGetProtectClient.mockResolvedValue(client);

		await startWs();
		await vi.advanceTimersByTimeAsync(5_000); // -> attempt 2
		await vi.advanceTimersByTimeAsync(10_000); // -> attempt 3
		await vi.advanceTimersByTimeAsync(30_000); // -> attempt 4 (success)
		expect(client.getBootstrap).toHaveBeenCalledTimes(4);

		// Now trigger another disconnect — backoff should be 5_000 (NOT 60_000),
		// proving _attempt was reset on success.
		client.__emit('login', false);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(client.getBootstrap).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(1);
		expect(client.getBootstrap).toHaveBeenCalledTimes(5);
	});

	it('stopWs — cancels in-flight backoff (no further reconnect after stop)', async () => {
		const client = makeClient();
		client.getBootstrap.mockResolvedValueOnce(false); // 1st fails -> schedules reconnect
		mockGetProtectClient.mockResolvedValue(client);

		await startWs();
		expect(client.getBootstrap).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		stopWs();
		expect(mockResetProtectClient).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0); // timer cancelled

		// Even if we advance past the would-be backoff, no further attempts.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(client.getBootstrap).toHaveBeenCalledTimes(1);
	});

	it('stopWs — without prior startWs — still calls resetProtectClient (idempotent)', () => {
		expect(() => stopWs()).not.toThrow();
		expect(mockResetProtectClient).toHaveBeenCalledTimes(1);
	});
});
