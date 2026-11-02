// v1.3 Phase 22 Plan 02 Task 1 — GET /api/cameras/status response shape regression.
//
// Verifies HUB-UI-01: the response includes the 6 hub scalar fields plus
// `streamCatalog` and `outputs` arrays for every cam row. External cams get
// populated arrays from a batched DB load (no N+1); managed cams get [].
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Fixture rows — minimal shape mirroring `cameras.$inferSelect`. Only the
// columns the handler reads need realistic values; the rest can be defaults.
// ────────────────────────────────────────────────────────────────────────────
const managedCam = {
	id: 1,
	vmid: 2001,
	name: 'Hof',
	ip: '192.0.2.91',
	username: 'admin',
	password: 'enc:dummy',
	cameraType: 'mobotix',
	streamPath: '/stream0/mobotix.mjpeg',
	width: 1280,
	height: 720,
	fps: 20,
	bitrate: 2000,
	streamName: 'hof',
	rtspUrl: null,
	containerIp: null,
	status: 'configured',
	accessCode: null,
	serialNumber: null,
	model: null,
	printState: null,
	streamMode: 'adaptive',
	rtspAuthEnabled: false,
	source: 'managed',
	mac: null,
	externalId: null,
	hubBridgeId: null,
	manufacturer: null,
	modelName: null,
	kind: 'unknown',
	createdAt: '2026-05-07T10:00:00Z',
	updatedAt: '2026-05-07T10:00:00Z'
};

const externalCam = {
	id: 23,
	vmid: 0,
	name: 'Carport (Protect)',
	ip: '0.0.0.0',
	username: '',
	password: '',
	cameraType: 'mobotix',
	streamPath: '',
	width: 0,
	height: 0,
	fps: 0,
	bitrate: 0,
	streamName: '',
	rtspUrl: null,
	containerIp: null,
	status: 'verified',
	accessCode: null,
	serialNumber: null,
	model: null,
	printState: null,
	streamMode: 'adaptive',
	rtspAuthEnabled: false,
	source: 'external',
	mac: 'aabbccddee01',
	externalId: 'protect-uuid-1',
	hubBridgeId: 1,
	manufacturer: 'Ubiquiti',
	modelName: 'G4 Bullet',
	kind: 'first-party',
	createdAt: '2026-05-07T10:00:00Z',
	updatedAt: '2026-05-07T10:00:00Z'
};

const catalogRows = [
	{
		cameraId: 23,
		quality: 'high',
		codec: 'h264',
		width: 1920,
		height: 1080,
		fps: 30,
		bitrate: 4000000
	},
	{
		cameraId: 23,
		quality: 'low',
		codec: 'h264',
		width: 640,
		height: 360,
		fps: 15,
		bitrate: 500000
	}
];

const outputsRows = [
	{ cameraId: 23, outputType: 'loxone-mjpeg', enabled: 1 } // SQLite stores boolean as INTEGER 0/1
];

// ────────────────────────────────────────────────────────────────────────────
// vi.mock setup — env, DB, services. Keep modules minimal so handler runs.
// ────────────────────────────────────────────────────────────────────────────
vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// Drizzle chain: handler does
//   db.select().from(cameras).all()                        — cam list
//   db.select(...).from(protectStreamCatalog).where(...)... — catalog batched
//   db.select(...).from(cameraOutputs).where(...)...        — outputs batched
// We branch by the `from(table)` arg.
const dbState = {
	cameraRows: [managedCam, externalCam] as any[],
	catalog: catalogRows as any[],
	outputs: outputsRows as any[]
};

const makeChain = (rows: any[]) => {
	const chain: any = {
		from: () => chain,
		where: () => chain,
		all: () => rows
	};
	return chain;
};

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: (_columns?: any) => {
			// Without column selector → full select on cameras.
			// With column selector → branched select (catalog or outputs).
			// We disambiguate by the `from(...)` call's argument identity later.
			let table: any = null;
			const chain: any = {
				from: (t: any) => {
					table = t;
					return chain;
				},
				where: () => chain,
				all: () => {
					if (table === fakeTables.cameras) return dbState.cameraRows;
					if (table === fakeTables.protectStreamCatalog) return dbState.catalog;
					if (table === fakeTables.cameraOutputs) return dbState.outputs;
					return [];
				}
			};
			return chain;
		}
	}
}));

const fakeTables = {
	cameras: { __t: 'cameras' },
	cameraOutputs: { __t: 'cameraOutputs' },
	protectStreamCatalog: { __t: 'protectStreamCatalog' }
};

vi.mock('$lib/server/db/schema', () => ({
	cameras: fakeTables.cameras,
	cameraOutputs: fakeTables.cameraOutputs,
	protectStreamCatalog: fakeTables.protectStreamCatalog
}));

vi.mock('$lib/server/services/proxmox', () => ({
	listContainers: vi.fn().mockRejectedValue(new Error('proxmox unreachable in test'))
}));
vi.mock('$lib/server/services/settings', () => ({
	getSettings: vi.fn().mockResolvedValue({})
}));
vi.mock('$lib/server/services/crypto', () => ({
	decrypt: vi.fn().mockReturnValue('decrypted')
}));
vi.mock('$lib/server/services/protect', () => ({
	getProtectStatus: vi.fn().mockRejectedValue(new Error('protect unreachable in test'))
}));
vi.mock('$lib/server/services/events', () => ({
	getFlappingCameras: vi.fn().mockReturnValue([])
}));
vi.mock('$lib/server/services/bambu-mqtt', () => ({
	getBambuState: vi.fn().mockReturnValue({ connected: false, error: null })
}));
vi.mock('$lib/server/services/bambu-discovery', () => ({
	PRINTER_CAPABILITIES: {
		H2C: {
			chamberHeater: true,
			ams: 'full',
			xcamFeatures: [],
			cameraResolution: '1080p',
			cameraTransport: 'rtsps-322'
		}
	}
}));

describe('GET /api/cameras/status — Phase 22 hub field expansion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('200 — returns array including 6 hub scalar fields + streamCatalog + outputs', async () => {
		const { GET } = await import('./+server');
		const res = await GET({} as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);

		const body = (await res.json()) as any[];
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(2);

		// Sorted alphabetically by name → Carport (Protect) first, then Hof
		const carport = body.find((c) => c.id === 23);
		const hof = body.find((c) => c.id === 1);
		expect(carport).toBeDefined();
		expect(hof).toBeDefined();

		// External cam: 6 scalar hub fields populated from cam row
		expect(carport.source).toBe('external');
		expect(carport.kind).toBe('first-party');
		expect(carport.manufacturer).toBe('Ubiquiti');
		expect(carport.modelName).toBe('G4 Bullet');
		expect(carport.externalId).toBe('protect-uuid-1');
		expect(carport.hubBridgeId).toBe(1);

		// External cam: streamCatalog populated from batched DB load (2 rows)
		expect(Array.isArray(carport.streamCatalog)).toBe(true);
		expect(carport.streamCatalog.length).toBe(2);
		const high = carport.streamCatalog.find((r: any) => r.quality === 'high');
		expect(high).toEqual({
			quality: 'high',
			codec: 'h264',
			width: 1920,
			height: 1080,
			fps: 30,
			bitrate: 4000000
		});

		// External cam: outputs populated (1 row)
		expect(Array.isArray(carport.outputs)).toBe(true);
		expect(carport.outputs.length).toBe(1);
		expect(carport.outputs[0]).toEqual({ outputType: 'loxone-mjpeg', enabled: true });

		// Managed cam: source defaults to 'managed', kind to 'unknown'
		expect(hof.source).toBe('managed');
		expect(hof.kind).toBe('unknown');
		expect(hof.manufacturer).toBeNull();
		expect(hof.modelName).toBeNull();
		expect(hof.externalId).toBeNull();
		expect(hof.hubBridgeId).toBeNull();
		// Managed cam: empty arrays (no leakage)
		expect(hof.streamCatalog).toEqual([]);
		expect(hof.outputs).toEqual([]);
	});

	it('regression — pre-existing fields still present on every row', async () => {
		const { GET } = await import('./+server');
		const res = await GET({} as Parameters<typeof GET>[0]);
		const body = (await res.json()) as any[];
		const hof = body.find((c) => c.id === 1);
		// Spot-check existing required fields are still emitted
		expect(hof.id).toBe(1);
		expect(hof.vmid).toBe(2001);
		expect(hof.name).toBe('Hof');
		expect(hof.cameraIp).toBe('192.0.2.91');
		expect(hof.cameraType).toBe('mobotix');
		expect(hof.status).toBe('configured');
		expect(hof.streamName).toBe('hof');
		expect(hof.snapshotUrl).toBe('/api/cameras/1/snapshot');
	});
});
