// Quick-task 260531-2zx — GET /api/cameras/health-summary response contract.
//
// Verifies DEBUG-TIER1-4: one CamHealthSummary per managed cam, JS-joined to
// the latest stream_health snapshot. Happy path covers a 'healthy' and a
// 'phantom' (phantomAdoption true) cam, sorted by name. A managed cam without a
// matching stream_health row resolves to status 'unknown' / phantomAdoption
// false / lastProbedAt null.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures — minimal shapes. cameras: {id,name,streamName,source}; the handler
// only selects id/name/streamName and filters source='managed'. stream_health:
// {streamKey,status,phantomAdoption,lastProbedAt}. streamKey === streamName for
// the matched cams.
// ────────────────────────────────────────────────────────────────────────────
const camHof = { id: 1, name: 'Hof', streamName: 'hof', source: 'managed' };
const camBalkon = { id: 2, name: 'Balkon', streamName: 'balkon', source: 'managed' };
// Managed cam with no stream_health snapshot → 'unknown'.
const camGarage = { id: 3, name: 'Garage', streamName: 'garage', source: 'managed' };

const healthHof = {
	streamKey: 'hof',
	status: 'healthy',
	phantomAdoption: false,
	lastProbedAt: '2026-05-31T00:00:10Z'
};
const healthBalkon = {
	streamKey: 'balkon',
	status: 'phantom',
	phantomAdoption: true,
	lastProbedAt: '2026-05-31T00:00:20Z'
};

// ────────────────────────────────────────────────────────────────────────────
// Drizzle chain mock. Handler does:
//   db.select({...}).from(cameras).where(eq(...)).all()       — managed cams
//   db.select({...}).from(streamHealth).all()                 — health rows
// Branch by the from(table) identity against fakeTables.
// ────────────────────────────────────────────────────────────────────────────
const dbState = {
	cameraRows: [camHof, camBalkon, camGarage] as any[],
	healthRows: [healthHof, healthBalkon] as any[]
};

const fakeTables = {
	cameras: { __t: 'cameras' },
	streamHealth: { __t: 'streamHealth' }
};

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: (_columns?: any) => {
			let table: any = null;
			const chain: any = {
				from: (t: any) => {
					table = t;
					return chain;
				},
				where: () => chain,
				all: () => {
					if (table === fakeTables.cameras) return dbState.cameraRows;
					if (table === fakeTables.streamHealth) return dbState.healthRows;
					return [];
				}
			};
			return chain;
		}
	}
}));

vi.mock('$lib/server/db/schema', () => ({
	cameras: fakeTables.cameras,
	streamHealth: fakeTables.streamHealth
}));

// eq is used only as a no-op argument to .where() in this read-only handler.
vi.mock('drizzle-orm', () => ({
	eq: (..._args: any[]) => ({ __eq: true })
}));

describe('GET /api/cameras/health-summary — cross-cam health ampel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('happy path — healthy + phantom cams, correct fields, sorted by name', async () => {
		const { GET } = await import('./+server');
		const res = await GET({} as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);

		const body = (await res.json()) as any[];
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(3);

		// Sorted by name: Balkon, Garage, Hof
		expect(body.map((c) => c.name)).toEqual(['Balkon', 'Garage', 'Hof']);

		const hof = body.find((c) => c.cameraId === 1);
		expect(hof).toEqual({
			cameraId: 1,
			name: 'Hof',
			status: 'healthy',
			phantomAdoption: false,
			lastProbedAt: '2026-05-31T00:00:10Z'
		});

		const balkon = body.find((c) => c.cameraId === 2);
		expect(balkon).toEqual({
			cameraId: 2,
			name: 'Balkon',
			status: 'phantom',
			phantomAdoption: true,
			lastProbedAt: '2026-05-31T00:00:20Z'
		});
	});

	it('cam without stream_health snapshot → status unknown / false / null', async () => {
		const { GET } = await import('./+server');
		const res = await GET({} as Parameters<typeof GET>[0]);
		const body = (await res.json()) as any[];

		const garage = body.find((c) => c.cameraId === 3);
		expect(garage).toEqual({
			cameraId: 3,
			name: 'Garage',
			status: 'unknown',
			phantomAdoption: false,
			lastProbedAt: null
		});
	});
});
