// Quick-task 260530-bv1 Task 3 — edge-only transition detection.
//
// Tests the PURE detectTransitions() helper in isolation: no timer, no DB.
// Verifies events fire only on an actual state change (edge), seed silently
// on first observation, and that both flags flipping in one tick yields two
// events. EventType/EventSeverity come from the existing $lib/types unions.
//
// $env/dynamic/private is mocked (as in events.test.ts) because the module
// import chain pulls db/client → crypto, which expects DB_ENCRYPTION_KEY.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// detectTransitions is a PURE function, but importing the sampler module pulls
// db/client (which would open a real SQLite file + run ALTER migrations against
// a non-existent `cameras` table). Stub the db so the import is side-effect free.
vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => ({ from: () => ({ where: () => ({ all: () => [] }) }) }),
		insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) })
	}
}));

import { detectTransitions } from './stream-health-sampler';

const ctx = { cameraName: 'Balkon', recAge: 120 };

describe('detectTransitions (edge-only)', () => {
	it('first observation (prev undefined) seeds silently → no events', () => {
		const out = detectTransitions('balkon', undefined, { phantom: false, producerAlive: true }, ctx);
		expect(out).toEqual([]);
	});

	it('steady state (prev === next, both healthy) → no events', () => {
		const out = detectTransitions(
			'balkon',
			{ phantom: false, producerAlive: true },
			{ phantom: false, producerAlive: true },
			ctx
		);
		expect(out).toEqual([]);
	});

	it('phantom false→true → one stream_failed/error event mentioning the camera', () => {
		const out = detectTransitions(
			'balkon',
			{ phantom: false, producerAlive: true },
			{ phantom: true, producerAlive: true },
			ctx
		);
		expect(out).toHaveLength(1);
		expect(out[0].eventType).toBe('stream_failed');
		expect(out[0].severity).toBe('error');
		expect(out[0].message).toContain('Balkon');
	});

	it('phantom true→false → one camera_reconnect/info event', () => {
		const out = detectTransitions(
			'balkon',
			{ phantom: true, producerAlive: true },
			{ phantom: false, producerAlive: true },
			ctx
		);
		expect(out).toHaveLength(1);
		expect(out[0].eventType).toBe('camera_reconnect');
		expect(out[0].severity).toBe('info');
	});

	it('producerAlive true→false → stream_failed/warning', () => {
		const out = detectTransitions(
			'balkon',
			{ phantom: false, producerAlive: true },
			{ phantom: false, producerAlive: false },
			ctx
		);
		expect(out).toHaveLength(1);
		expect(out[0].eventType).toBe('stream_failed');
		expect(out[0].severity).toBe('warning');
	});

	it('producerAlive false→true → camera_reconnect/info', () => {
		const out = detectTransitions(
			'balkon',
			{ phantom: false, producerAlive: false },
			{ phantom: false, producerAlive: true },
			ctx
		);
		expect(out).toHaveLength(1);
		expect(out[0].eventType).toBe('camera_reconnect');
		expect(out[0].severity).toBe('info');
	});

	it('both flags flip in one tick → two events', () => {
		const out = detectTransitions(
			'balkon',
			{ phantom: false, producerAlive: true },
			{ phantom: true, producerAlive: false },
			ctx
		);
		expect(out).toHaveLength(2);
		const types = out.map((e) => e.eventType);
		expect(types).toContain('stream_failed');
	});
});
