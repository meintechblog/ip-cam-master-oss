// v1.3 Phase 21 Plan 05 — POST /api/protect-hub/reconcile (force) + GET /api/protect-hub/reconcile-runs (poll).
// Replaces the Wave-0 stub. Covers HUB-RCN-03.
//
// POST: returns 202 + { ok: true, reconcileId }; spawns reconcile() in
//       the background; passes the freshly-minted UUID as externalReconcileId
//       so the client can poll the audit row by the same id (Plan 05 Task 1
//       extension to reconcile.ts).
// GET:  reads ?reconcileId=…; returns 400 if missing, 404 if not found,
//       200 + { ok: true, run } when the row exists.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

const mockReconcile = vi.fn().mockResolvedValue({
	ok: true,
	status: 'success',
	reconcileId: 'will-be-overwritten-by-route',
	hashChanged: true,
	newHash: 'h',
	outputCount: 0
});

const bridgeRowMock = {
	id: 1,
	vmid: 2014,
	hostname: 'protect-hub',
	containerIp: '192.0.2.244',
	status: 'running'
};

// Drizzle .select().from(...).where(...).limit(...).get() | .select().from(...).where(...).get()
// — both endpoints share the same chain shape; selectGet is reassigned per test.
const selectChain: {
	from: () => typeof selectChain;
	where: () => typeof selectChain;
	limit: () => typeof selectChain;
	get: ReturnType<typeof vi.fn>;
} = {
	from: () => selectChain,
	where: () => selectChain,
	limit: () => selectChain,
	get: vi.fn(() => bridgeRowMock)
};

vi.mock('$lib/server/db/client', () => ({
	db: { select: () => selectChain }
}));

vi.mock('$lib/server/db/schema', () => ({
	protectHubBridges: {},
	protectHubReconcileRuns: {}
}));

vi.mock('$lib/server/orchestration/protect-hub/reconcile', () => ({
	reconcile: mockReconcile
}));

describe('POST /api/protect-hub/reconcile (Plan 05 — force-reconcile)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		// Default: a running bridge exists.
		selectChain.get = vi.fn(() => bridgeRowMock);
		mockReconcile.mockResolvedValue({
			ok: true,
			status: 'success',
			reconcileId: 'will-be-overwritten-by-route',
			hashChanged: true,
			newHash: 'h',
			outputCount: 0
		});
	});

	// HUB-RCN-03 — non-blocking 202 + reconcileId per D-API-01
	it('returns 202 + { ok: true, reconcileId } when a running bridge exists', async () => {
		const { POST } = await import('./+server');
		const res = (await POST({} as Parameters<typeof POST>[0])) as Response;

		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(typeof body.reconcileId).toBe('string');
		expect(body.reconcileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

		// reconcile() spawned in background with the same reconcileId we returned
		// (so client polling /reconcile-runs?reconcileId=… finds the audit row)
		expect(mockReconcile).toHaveBeenCalledTimes(1);
		expect(mockReconcile).toHaveBeenCalledWith(bridgeRowMock.id, 'force', body.reconcileId);
	});

	it('returns 503 with reason="no_running_bridge" when no bridge is in status=running', async () => {
		selectChain.get = vi.fn(() => undefined);
		const { POST } = await import('./+server');
		const res = (await POST({} as Parameters<typeof POST>[0])) as Response;

		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(mockReconcile).not.toHaveBeenCalled();
	});
});

describe('GET /api/protect-hub/reconcile-runs (Plan 05 — poll status by id)', () => {
	const runRowMock = {
		id: 1,
		reconcileId: 'abc-123',
		startedAt: '2026-05-06T13:00:00.000Z',
		completedAt: '2026-05-06T13:00:01.000Z',
		status: 'success',
		hashChanged: 1,
		deployedYamlHash: 'h',
		error: null
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it('returns 400 when reconcileId query param is missing', async () => {
		selectChain.get = vi.fn(); // never called — short-circuit on missing param
		const { GET } = await import('../reconcile-runs/+server');
		const res = (await GET({ url: new URL('http://x/?other=foo') } as Parameters<typeof GET>[0])) as Response;

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/reconcileId/i);
		expect(selectChain.get).not.toHaveBeenCalled();
	});

	it('returns 404 when no run row matches the supplied reconcileId', async () => {
		selectChain.get = vi.fn(() => undefined);
		const { GET } = await import('../reconcile-runs/+server');
		const res = (await GET({
			url: new URL('http://x/?reconcileId=missing-uuid')
		} as Parameters<typeof GET>[0])) as Response;

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.ok).toBe(false);
	});

	it('returns 200 + { ok: true, run } when the run row exists', async () => {
		selectChain.get = vi.fn(() => runRowMock);
		const { GET } = await import('../reconcile-runs/+server');
		const res = (await GET({
			url: new URL('http://x/?reconcileId=abc-123')
		} as Parameters<typeof GET>[0])) as Response;

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.run.reconcileId).toBe('abc-123');
		expect(body.run.status).toBe('success');
	});
});
