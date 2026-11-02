// v1.3 Phase 21 Plan 05 — PUT /api/cameras/[id]/outputs.
// Replaces the Wave-0 stub. Covers HUB-OUT-01, HUB-OUT-04, HUB-RCN-02 + D-CAP-01/02 wording.
//
// Mock-chain ORDER assumed by these tests (matches +server.ts SELECT order):
//   1) cameras lookup (by id)
//   2) count(*) of MJPEG outputs on OTHER cams (cap check)
//   3) protect_hub_bridges row WHERE status='running' (for the reconcile fan-out)
// If +server.ts reorders SELECTs, the .mockReturnValueOnce sequence below must
// be updated to match. The +server.ts file documents this contract in a header
// comment for downstream maintainers.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

const mockReconcile = vi.fn().mockResolvedValue({
	ok: true,
	status: 'success',
	reconcileId: 'r',
	hashChanged: true,
	newHash: 'h',
	outputCount: 0
});
const mockStoreEvent = vi.fn();

const camRow = {
	id: 1,
	name: 'Carport',
	source: 'external',
	mac: 'aabbccddee01',
	kind: 'first-party'
};
const bridgeRow = { id: 1, vmid: 2014, status: 'running' };

const selectChain: {
	from: () => typeof selectChain;
	where: () => typeof selectChain;
	limit: () => typeof selectChain;
	get: ReturnType<typeof vi.fn>;
} = {
	from: () => selectChain,
	where: () => selectChain,
	limit: () => selectChain,
	get: vi.fn()
};
// .insert(...).values(...).run() and .delete(...).where(...).run()
const deleteRun = vi.fn();
const insertRun = vi.fn();
const deleteChain = { where: () => ({ run: deleteRun }) };
const insertChain = { values: () => ({ run: insertRun }) };

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => selectChain,
		delete: () => deleteChain,
		insert: () => insertChain
	}
}));

vi.mock('$lib/server/db/schema', () => ({
	cameras: {},
	cameraOutputs: { cameraId: {}, outputType: {}, enabled: {} },
	protectHubBridges: {}
}));

vi.mock('$lib/server/orchestration/protect-hub/reconcile', () => ({
	reconcile: mockReconcile
}));

vi.mock('$lib/server/services/events', () => ({
	storeEvent: mockStoreEvent
}));

// Helper: build a request shape compatible with the SvelteKit RequestHandler
// signature. Tests pass plain objects via `as Parameters<typeof PUT>[0]`.
const req = (body: unknown, id = '1') =>
	({
		params: { id },
		request: { json: async () => body }
	}) as unknown;

describe('PUT /api/cameras/[id]/outputs (Plan 05)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default sequence: 1=camera, 2=count, 3=bridge.
		// Most tests use this; specific tests override per-call below.
		selectChain.get = vi
			.fn()
			.mockReturnValueOnce(camRow)
			.mockReturnValueOnce({ n: 0 })
			.mockReturnValueOnce(bridgeRow);
	});

	// HUB-OUT-01 — happy path: 1 Loxone-MJPEG → row written + reconcile triggered (HUB-RCN-02)
	it('200 — body with 1 Loxone-MJPEG output → row written + reconcile called', async () => {
		const { PUT } = await import('./+server');
		const res = (await PUT(
			req({ outputs: [{ outputType: 'loxone-mjpeg', enabled: true }] }) as Parameters<typeof PUT>[0]
		)) as Response;

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.projectedMjpegCount).toBe(1);

		// HUB-RCN-02 — force-reconcile triggered after DB write
		expect(mockReconcile).toHaveBeenCalledTimes(1);
		expect(mockReconcile).toHaveBeenCalledWith(bridgeRow.id, 'output_toggle');

		// Replace strategy: existing rows for cam are deleted before insert
		expect(deleteRun).toHaveBeenCalledTimes(1);
		// New row inserted
		expect(insertRun).toHaveBeenCalledTimes(1);
	});

	// HUB-OUT-04 — D-CAP-02 hard cap: projected total > VAAPI_HARD_CAP → 422
	// with exact German wording. Cap raised 6 → 12 on 2026-05-16 (Arrow Lake-P).
	it('422 — projected total > 12 MJPEG → vaapi_hard_cap_exceeded with D-CAP-02 message', async () => {
		// 12 already enabled on OTHER cams + 1 requested = 13 → over cap
		selectChain.get = vi.fn().mockReturnValueOnce(camRow).mockReturnValueOnce({ n: 12 });

		const { PUT } = await import('./+server');
		const res = (await PUT(
			req({ outputs: [{ outputType: 'loxone-mjpeg', enabled: true }] }) as Parameters<typeof PUT>[0]
		)) as Response;

		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.reason).toBe('vaapi_hard_cap_exceeded');
		// D-CAP-02 EXACT prefix match (German). Number is dynamic (=projectedTotal).
		expect(body.message).toBe(
			'Maximal 12 gleichzeitige Loxone-MJPEG-Transkodierungen pro Bridge möglich. Aktuell: 13.'
		);

		// Cap rejected BEFORE any DB write or reconcile
		expect(deleteRun).not.toHaveBeenCalled();
		expect(insertRun).not.toHaveBeenCalled();
		expect(mockReconcile).not.toHaveBeenCalled();
	});

	// L-26 / D-CAP-02 — Frigate-RTSP outputs are NOT counted toward the cap
	it('200 — Frigate-RTSP outputs do NOT count toward VAAPI cap', async () => {
		// 12 already enabled on OTHER cams (at the MJPEG cap)
		// + 1 requested Frigate-RTSP → 12 projected MJPEG, OK because passthrough is zero VAAPI cost
		selectChain.get = vi
			.fn()
			.mockReturnValueOnce(camRow)
			.mockReturnValueOnce({ n: 12 })
			.mockReturnValueOnce(bridgeRow);

		const { PUT } = await import('./+server');
		const res = (await PUT(
			req({ outputs: [{ outputType: 'frigate-rtsp', enabled: true }] }) as Parameters<typeof PUT>[0]
		)) as Response;

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.projectedMjpegCount).toBe(12); // unchanged; frigate doesn't add
		expect(mockReconcile).toHaveBeenCalledTimes(1);
	});

	// D-CAP-01 — soft cap: projected total >= VAAPI_SOFT_CAP emits vaapi_soft_cap_warning event AFTER write
	it('emits vaapi_soft_cap_warning event when projected total >= 10', async () => {
		// 9 enabled elsewhere + 1 requested = 10 → soft cap
		selectChain.get = vi
			.fn()
			.mockReturnValueOnce(camRow)
			.mockReturnValueOnce({ n: 9 })
			.mockReturnValueOnce(bridgeRow);

		const { PUT } = await import('./+server');
		await PUT(
			req({ outputs: [{ outputType: 'loxone-mjpeg', enabled: true }] }) as Parameters<typeof PUT>[0]
		);

		expect(mockStoreEvent).toHaveBeenCalledTimes(1);
		expect(mockStoreEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: 'vaapi_soft_cap_warning',
				severity: 'info',
				cameraId: null,
				cameraName: 'Protect Hub'
			})
		);
		// And the event is emitted AFTER the DB write (write must succeed first per plan).
		// We assert order via call invocation order:
		expect(insertRun.mock.invocationCallOrder[0]).toBeLessThan(
			mockStoreEvent.mock.invocationCallOrder[0]
		);
	});

	// Soft cap NOT emitted when projected total < 10
	it('does NOT emit vaapi_soft_cap_warning when projected total < 10', async () => {
		selectChain.get = vi
			.fn()
			.mockReturnValueOnce(camRow)
			.mockReturnValueOnce({ n: 2 })
			.mockReturnValueOnce(bridgeRow);

		const { PUT } = await import('./+server');
		await PUT(
			req({ outputs: [{ outputType: 'loxone-mjpeg', enabled: true }] }) as Parameters<typeof PUT>[0]
		);
		expect(mockStoreEvent).not.toHaveBeenCalled();
	});

	// T-21-12 mitigation — unknown outputType rejected BEFORE any DB write
	it('400 — unknown outputType → rejected before any DB write', async () => {
		const { PUT } = await import('./+server');
		const res = (await PUT(
			req({ outputs: [{ outputType: 'wat', enabled: true }] }) as Parameters<typeof PUT>[0]
		)) as Response;

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.reason).toBe('unknown_output_type');
		expect(deleteRun).not.toHaveBeenCalled();
		expect(insertRun).not.toHaveBeenCalled();
		expect(mockReconcile).not.toHaveBeenCalled();
	});

	it('404 — camera not found', async () => {
		selectChain.get = vi.fn().mockReturnValueOnce(undefined);
		const { PUT } = await import('./+server');
		const res = (await PUT(req({ outputs: [] }) as Parameters<typeof PUT>[0])) as Response;
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.reason).toBe('camera_not_found');
		expect(deleteRun).not.toHaveBeenCalled();
	});

	it('400 — managed cam (source != external) cannot have hub outputs', async () => {
		selectChain.get = vi.fn().mockReturnValueOnce({ ...camRow, source: 'managed' });
		const { PUT } = await import('./+server');
		const res = (await PUT(req({ outputs: [] }) as Parameters<typeof PUT>[0])) as Response;
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.reason).toBe('not_protect_hub_cam');
	});

	it('400 — invalid camera id (NaN)', async () => {
		const { PUT } = await import('./+server');
		const res = (await PUT(req({ outputs: [] }, 'foo') as Parameters<typeof PUT>[0])) as Response;
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.reason).toBe('invalid_camera_id');
	});

	it('400 — body.outputs missing or not an array', async () => {
		const { PUT } = await import('./+server');
		const res = (await PUT(req({}) as Parameters<typeof PUT>[0])) as Response;
		expect(res.status).toBe(400);
	});
});
