import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the protect-bridge boundary — no real client, no settings/db import chain.
const getProtectClient = vi.fn();
vi.mock('$lib/server/services/protect-bridge', () => ({
	getProtectClient: (...args: unknown[]) => getProtectClient(...args)
}));

import { GET } from './+server';

type Handler = (e: { url: URL }) => Promise<Response>;
const get = GET as unknown as Handler;

const AUFFAHRT_ID = '000000000000000000000001'; // the calibrated camera (birdeye-mapper)

// Analytics-frame coord whose foot point (375, 283.5) scales to the calibration
// frame's Gully ground anchor (250, 189) — guaranteed to map inside the aerial.
const GULLY_COORD = [355, 233.5, 40, 50];

function makeClient(events: unknown, retrieveImpl?: (url: string) => unknown) {
	const retrieve = vi.fn(async (url: string) => {
		if (retrieveImpl) return retrieveImpl(url);
		return { statusCode: 200, body: { json: async () => events } };
	});
	return {
		client: {
			bootstrap: { cameras: [{ id: AUFFAHRT_ID, name: 'Auffahrt' }] },
			getBootstrap: vi.fn(async () => true),
			getApiEndpoint: (e: string) => `https://192.0.2.1/proxy/protect/api/${e}`,
			retrieve
		},
		retrieve
	};
}

function makeUrl(query = ''): URL {
	return new URL(`http://localhost/api/detections/birdeye${query}`);
}

// The endpoint keeps a module-local circuit breaker (30s). Tests control time
// via a mocked Date.now and jump far past the breaker window before each test,
// so breaker state can never leak from one test into the next.
let nowBase = 1_765_400_000_000;

beforeEach(() => {
	getProtectClient.mockReset();
	nowBase += 600_000; // 10 min jump — clears any breaker tripped by a prior test
	vi.spyOn(Date, 'now').mockImplementation(() => nowBase);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('GET /api/detections/birdeye', () => {
	it('graceful disconnected path: client error → 200, ok:true, empty positions', async () => {
		getProtectClient.mockRejectedValue(new Error('UniFi credentials not configured.'));
		const res = await get({ url: makeUrl() });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.positions).toEqual([]);
		expect(body.reason).toBe('disconnected');
	});

	it('maps a calibrated detection and copies ONLY the whitelist fields', async () => {
		const events = [
			{
				id: 'ev1',
				camera: AUFFAHRT_ID,
				start: 1765400000000,
				end: 1765400005000,
				smartDetectTypes: ['person'],
				metadata: {
					detectedThumbnails: [
						{
							type: 'person',
							coord: GULLY_COORD,
							confidence: 87,
							// PII / forbidden fields — must NEVER reach the response:
							labels: ['groupType:known', 'group:abc123'],
							croppedId: 'crop-1',
							objectId: 'obj-1',
							attributes: { color: 'red' },
							name: 'XX-YY-123'
						}
					]
				}
			},
			// uncalibrated camera → dropped entirely
			{
				id: 'ev2',
				camera: 'someOtherCamera',
				start: 1765400001000,
				smartDetectTypes: ['vehicle'],
				metadata: { detectedThumbnails: [{ type: 'vehicle', coord: GULLY_COORD }] }
			}
		];
		getProtectClient.mockResolvedValue(makeClient(events).client);

		const res = await get({ url: makeUrl() });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.mapImage).toBe('/birdeye/luftbild.jpg');
		expect(body.mapSize).toEqual({ width: 1101, height: 823 });
		expect(body.positions).toHaveLength(1);

		const pos = body.positions[0];
		// EXACT whitelist — no extra keys, ever.
		expect(Object.keys(pos).sort()).toEqual(['camera', 'cameraName', 'score', 'ts', 'type', 'x', 'y']);
		expect(pos.camera).toBe(AUFFAHRT_ID);
		expect(pos.cameraName).toBe('Auffahrt');
		expect(pos.type).toBe('person');
		expect(pos.score).toBe(87);
		expect(pos.ts).toBe(1765400000000);
		expect(typeof pos.x).toBe('number');
		expect(typeof pos.y).toBe('number');
		expect(pos.x).toBeGreaterThanOrEqual(0);
		expect(pos.x).toBeLessThan(1101);
		expect(pos.y).toBeGreaterThanOrEqual(0);
		expect(pos.y).toBeLessThan(823);

		// Belt-and-braces: forbidden values never appear anywhere in the payload.
		const raw = JSON.stringify(body);
		for (const leak of ['labels', 'croppedId', 'objectId', 'attributes', 'XX-YY-123', 'groupType']) {
			expect(raw).not.toContain(leak);
		}
	});

	it('clamps minutes to [1,60], defaults to 10 (incl. empty string)', async () => {
		const windows: number[] = [];
		const { client } = makeClient([], (url) => {
			const u = new URL(url);
			windows.push(Number(u.searchParams.get('end')) - Number(u.searchParams.get('start')));
			return { statusCode: 200, body: { json: async () => [] } };
		});
		getProtectClient.mockResolvedValue(client);

		await get({ url: makeUrl('?minutes=999') });
		await get({ url: makeUrl('?minutes=0') });
		await get({ url: makeUrl('?minutes=abc') });
		await get({ url: makeUrl('?minutes=') }); // empty string ≠ 0 → default
		await get({ url: makeUrl() });

		expect(windows).toEqual([60 * 60_000, 1 * 60_000, 10 * 60_000, 10 * 60_000, 10 * 60_000]);
	});

	it('failed retrieve (lib resolves null on non-2xx/timeout) → 502 events_unavailable', async () => {
		// unifi-protect with the default decodeResponse NEVER yields a non-2xx
		// ResponseData — failures resolve to null. Test the real path.
		const { client } = makeClient([], () => null);
		getProtectClient.mockResolvedValue(client);
		const res = await get({ url: makeUrl() });
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.reason).toBe('events_unavailable');
		expect(body.positions).toEqual([]);
	});

	it('circuit breaker: after a failure, the next call is answered WITHOUT touching Protect', async () => {
		const { client, retrieve } = makeClient([], () => null);
		getProtectClient.mockResolvedValue(client);

		// 1st call: retrieve fails → 502 + breaker trips (retryAfterMs present).
		const first = await get({ url: makeUrl() });
		expect(first.status).toBe(502);
		expect(retrieve).toHaveBeenCalledTimes(1);
		// retrieve must silence the lib's per-call error logging (3s poll spam).
		expect((retrieve.mock.calls[0] as unknown[])[2]).toEqual({ logErrors: false });
		const firstBody = await first.json();
		expect(firstBody.retryAfterMs).toBe(30_000);

		// 2nd call (5s later, inside the 30s window): served from the breaker —
		// retrieve is NOT called again, response replays the last failure status.
		nowBase += 5_000;
		const second = await get({ url: makeUrl() });
		expect(retrieve).toHaveBeenCalledTimes(1);
		expect(getProtectClient).toHaveBeenCalledTimes(1);
		expect(second.status).toBe(502);
		const secondBody = await second.json();
		expect(secondBody.ok).toBe(false);
		expect(secondBody.reason).toBe('events_unavailable');
		expect(secondBody.retryAfterMs).toBe(25_000);

		// 3rd call after the window: Protect is contacted again; success resets
		// the breaker, so the following call also goes through.
		nowBase += 30_000;
		const { client: okClient, retrieve: okRetrieve } = makeClient([]);
		getProtectClient.mockResolvedValue(okClient);
		const third = await get({ url: makeUrl() });
		expect(third.status).toBe(200);
		expect(okRetrieve).toHaveBeenCalledTimes(1);
		await get({ url: makeUrl() });
		expect(okRetrieve).toHaveBeenCalledTimes(2);
	});
});
