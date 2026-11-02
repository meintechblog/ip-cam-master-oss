// Quick-task 260530-fff Task 3 — buildCameraDebugHealth aggregator.
//
// Deterministic unit test: every probe the aggregator pulls in is mocked, so
// there is no real network and no real DB. Covers:
//   1. happy path — every layer present + probedAt set
//   2. fail-soft — bootstrap failure folds the protect layer to matched:false
//      and the function still resolves with the other layers intact
//   3. phantom logic — CONNECTED + recordingEnd older than 90s → phantom true;
//      a fresh recordingEnd → phantom false
//   4. device-layer applicability — a 'bambu'/'external' cam → applicable:false
//      without ever calling decrypt
import { describe, it, expect, vi, beforeEach } from 'vitest';

// env first — the import chain transitively loads crypto/env config.
vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// Schema + db client — importing the aggregator (and its deps) must not open a
// real SQLite file. streamHealth read returns null by default (overridable).
let _snapshotRow: Record<string, unknown> | null = null;
vi.mock('$lib/server/db/schema', () => ({
	cameras: { id: 'id', streamName: 'streamName' },
	streamHealth: { streamKey: 'streamKey' }
}));
vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					get: () => _snapshotRow,
					all: () => []
				})
			})
		})
	},
	sqlite: {},
	DB_ABS_PATH: ''
}));

// The four service deps the aggregator imports.
const mockProbeGo2rtc = vi.fn();
const mockFetchBootstrap = vi.fn();
const mockVerifyOnvifServer = vi.fn();
const mockGetEvents = vi.fn();
const mockDecrypt = vi.fn((s: string) => s);

vi.mock('./stream-health-sampler', () => ({
	probeGo2rtc: (...args: unknown[]) => mockProbeGo2rtc(...args)
}));
vi.mock('./protect-bridge', () => ({
	fetchBootstrap: (...args: unknown[]) => mockFetchBootstrap(...args)
}));
vi.mock('./protect', () => ({
	verifyOnvifServer: (...args: unknown[]) => mockVerifyOnvifServer(...args)
}));
vi.mock('./events', () => ({
	getEvents: (...args: unknown[]) => mockGetEvents(...args)
}));
vi.mock('./crypto', () => ({
	decrypt: (...args: unknown[]) => mockDecrypt(...(args as [string]))
}));

// Device/ONVIF probes use node:http + global fetch. Stub both so a Mobotix cam
// resolves instantly instead of hitting the network. The aggregator is
// fail-soft, so even a rejecting stub keeps the function resolving.
vi.mock('node:http', () => ({
	request: (_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
		const res = {
			statusCode: 200,
			on: (ev: string, fn: (...a: unknown[]) => void) => {
				if (ev === 'end') fn();
			}
		};
		queueMicrotask(() => cb(res));
		return {
			on: () => {},
			setTimeout: () => {},
			destroy: () => {},
			end: () => {}
		};
	}
}));

import { buildCameraDebugHealth } from './camera-debug-health';

// A minimal cameras row — only the fields the aggregator reads matter; cast to
// the row type the function expects.
type CameraInput = Parameters<typeof buildCameraDebugHealth>[0];
function makeCamera(overrides: Partial<CameraInput> = {}): CameraInput {
	return {
		id: 7,
		vmid: 207,
		name: 'Balkon',
		ip: '192.0.2.50',
		username: 'admin',
		password: 'enc:secret',
		cameraType: 'mobotix',
		streamName: 'balkon',
		containerIp: '192.0.2.207',
		status: 'verified',
		source: 'managed',
		...overrides
	} as unknown as CameraInput;
}

const HEALTHY_GO2RTC = {
	reachable: true,
	streamFound: true,
	producersConfigured: 1,
	producersStarted: 1,
	consumers: 1,
	bytesRecv: 12345
};

beforeEach(() => {
	vi.clearAllMocks();
	_snapshotRow = null;
	mockProbeGo2rtc.mockResolvedValue(HEALTHY_GO2RTC);
	mockVerifyOnvifServer.mockResolvedValue({ running: true, reachable: true });
	mockGetEvents.mockReturnValue({ events: [{ id: 1 }], total: 1 });
	global.fetch = vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
});

describe('buildCameraDebugHealth', () => {
	it('happy path — every layer present and probedAt set', async () => {
		mockFetchBootstrap.mockResolvedValue({
			ok: true,
			cameras: [
				{
					name: 'Balkon',
					state: 'CONNECTED',
					isRecording: true,
					lastSeen: Date.now() - 5_000,
					stats: { video: { recordingEnd: Date.now() - 2_000 } }
				}
			]
		});
		_snapshotRow = {
			status: 'healthy',
			producerAlive: true,
			consumers: 1,
			recordingEndAgeSeconds: 2,
			phantomAdoption: false,
			lastProbedAt: '2026-05-30T09:00:00.000Z'
		};

		const result = await buildCameraDebugHealth(makeCamera());

		expect(result.camera.id).toBe(7);
		expect(result.camera.name).toBe('Balkon');
		expect(result.layers.go2rtc.reachable).toBe(true);
		expect(result.layers.protect.matched).toBe(true);
		expect(result.layers.device.applicable).toBe(true);
		expect(result.layers.onvif).toBeDefined();
		expect(result.layers.snapshot).not.toBeNull();
		expect(result.layers.snapshot?.status).toBe('healthy');
		expect(result.recentEvents).toHaveLength(1);
		expect(typeof result.probedAt).toBe('string');
		expect(result.probedAt).not.toBe('');
		// go2rtc probe was reused with the cam's container + stream
		expect(mockProbeGo2rtc).toHaveBeenCalledWith('192.0.2.207', 'balkon');
	});

	it('fail-soft — bootstrap failure folds protect to matched:false, still resolves', async () => {
		mockFetchBootstrap.mockResolvedValue({
			ok: false,
			reason: 'controller_unreachable',
			error: new Error('ECONNREFUSED')
		});

		const result = await buildCameraDebugHealth(makeCamera());

		expect(result.layers.protect.matched).toBe(false);
		expect(result.layers.protect.phantom).toBe(false);
		// other layers intact
		expect(result.layers.go2rtc.reachable).toBe(true);
		expect(result.recentEvents).toHaveLength(1);
	});

	it('phantom logic — CONNECTED + recordingEnd older than 90s → phantom true', async () => {
		mockFetchBootstrap.mockResolvedValue({
			ok: true,
			cameras: [
				{
					name: 'Balkon',
					state: 'CONNECTED',
					isRecording: false,
					lastSeen: Date.now() - 1_000,
					stats: { video: { recordingEnd: Date.now() - 120_000 } } // 120s stale
				}
			]
		});

		const result = await buildCameraDebugHealth(makeCamera());

		expect(result.layers.protect.matched).toBe(true);
		expect(result.layers.protect.phantom).toBe(true);
		expect(result.layers.protect.recordingEndAgeSeconds).toBeGreaterThan(90);
	});

	it('phantom logic — fresh recordingEnd → phantom false', async () => {
		mockFetchBootstrap.mockResolvedValue({
			ok: true,
			cameras: [
				{
					name: 'Balkon',
					state: 'CONNECTED',
					isRecording: true,
					lastSeen: Date.now() - 1_000,
					stats: { video: { recordingEnd: Date.now() - 3_000 } } // 3s fresh
				}
			]
		});

		const result = await buildCameraDebugHealth(makeCamera());

		expect(result.layers.protect.matched).toBe(true);
		expect(result.layers.protect.phantom).toBe(false);
	});

	it('device-layer applicability — bambu cam → applicable:false, decrypt not called', async () => {
		mockFetchBootstrap.mockResolvedValue({ ok: true, cameras: [] });

		const result = await buildCameraDebugHealth(
			makeCamera({ cameraType: 'bambu' } as Partial<CameraInput>)
		);

		expect(result.layers.device.applicable).toBe(false);
		expect(result.layers.device.reachable).toBe(false);
		expect(mockDecrypt).not.toHaveBeenCalled();
	});

	it('device-layer applicability — external cam → applicable:false, decrypt not called', async () => {
		mockFetchBootstrap.mockResolvedValue({ ok: true, cameras: [] });

		const result = await buildCameraDebugHealth(
			makeCamera({ cameraType: 'external', source: 'external' } as Partial<CameraInput>)
		);

		expect(result.layers.device.applicable).toBe(false);
		expect(mockDecrypt).not.toHaveBeenCalled();
	});
});
