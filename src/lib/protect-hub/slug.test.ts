// v1.3 Phase 22 Plan 02 Task 2 — slug + URL derivation parity test.
//
// Verifies:
//   1. `deriveSlug` shape: '<mac>-low' for loxone-mjpeg, '<mac>-high' for frigate-rtsp
//   2. Empty-mac guard (Pitfall #9)
//   3. `deriveStreamUrl` shape (Loxone HTTP + Frigate RTSP)
//   4. PARITY with the server-side `deriveSlug(row)` in yaml-builder.ts —
//      the on-disk YAML key MUST match what the browser tells the user to copy.
//      Drift between the two is silent in production (URL doesn't resolve);
//      this test catches it at CI time.
import { describe, it, expect } from 'vitest';
import { deriveSlug, deriveStreamUrl } from './slug';
import { deriveSlug as deriveSlugServer } from '$lib/server/orchestration/protect-hub/yaml-builder';

describe('deriveSlug (browser-shareable)', () => {
	it("returns '<mac>-low' for loxone-mjpeg", () => {
		expect(deriveSlug('aa11bb22cc33', 'loxone-mjpeg')).toBe('aa11bb22cc33-low');
	});

	it("returns '<mac>-high' for frigate-rtsp", () => {
		expect(deriveSlug('aa11bb22cc33', 'frigate-rtsp')).toBe('aa11bb22cc33-high');
	});

	it('throws when mac is empty', () => {
		expect(() => deriveSlug('', 'loxone-mjpeg')).toThrow();
	});
});

describe('deriveStreamUrl', () => {
	it('builds Loxone HTTP URL on :1984/api/stream.mjpeg', () => {
		expect(deriveStreamUrl('192.0.2.139', 'aa11bb22cc33', 'loxone-mjpeg')).toBe(
			'http://192.0.2.139:1984/api/stream.mjpeg?src=aa11bb22cc33-low'
		);
	});

	it('builds Frigate RTSP URL on :8554', () => {
		expect(deriveStreamUrl('192.0.2.139', 'aa11bb22cc33', 'frigate-rtsp')).toBe(
			'rtsp://192.0.2.139:8554/aa11bb22cc33-high'
		);
	});
});

describe('slug parity (browser ↔ server yaml-builder)', () => {
	const sampleMacs = [
		'aa11bb22cc33',
		'deadbeef0001',
		'001122334455',
		'ffeeddccbbaa',
		'74acb9112233'
	];
	const outputTypes = ['loxone-mjpeg', 'frigate-rtsp'] as const;

	for (const mac of sampleMacs) {
		for (const outputType of outputTypes) {
			it(`server === browser for (${mac}, ${outputType})`, () => {
				const browserSlug = deriveSlug(mac, outputType);
				// yaml-builder's deriveSlug consumes an OutputRow — feed it a
				// minimal one with the same primitives.
				const serverSlug = deriveSlugServer({
					cameraId: 1,
					mac,
					outputType,
					rtspUrl: 'rtsp://x'
				});
				expect(browserSlug).toBe(serverSlug);
			});
		}
	}
});
