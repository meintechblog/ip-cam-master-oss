// Bird-Eye M2 Slice 1 — oracle tests for the pure mapper. All expected values
// were fixed BEFORE the TS port, taken from the verified M0 spike
// (.planning/spikes/birdeye-m0/{kalibrierung.json,pipeline.py}): if one of
// these misses, the implementation diverged from the reference math — fix the
// implementation, never widen the tolerance.

import { describe, it, expect } from 'vitest';
import {
	footPoint,
	mapCameraPoint,
	mapDetection,
	getBirdeyeCalibration,
	type BirdeyeCalibration
} from './birdeye-mapper';

const AUFFAHRT_ID = '000000000000000000000001';

function cal(): BirdeyeCalibration {
	const c = getBirdeyeCalibration(AUFFAHRT_ID);
	if (!c) throw new Error('Auffahrt calibration missing from registry');
	return c;
}

describe('birdeye-mapper (Auffahrt calibration)', () => {
	it('maps the Gully anchor (250,189) to aerial (72,431) within 0.5px', () => {
		const mapped = mapCameraPoint(cal(), { x: 250, y: 189 });
		expect(mapped).not.toBeNull();
		expect(Math.abs(mapped!.x - 72)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(mapped!.y - 431)).toBeLessThanOrEqual(0.5);
	});

	it('maps the SE carport post (462,257) to aerial (243,392) within 0.5px', () => {
		const mapped = mapCameraPoint(cal(), { x: 462, y: 257 });
		expect(mapped).not.toBeNull();
		expect(Math.abs(mapped!.x - 243)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(mapped!.y - 392)).toBeLessThanOrEqual(0.5);
	});

	it('measures Gully → SE post as 4.01m on the map (±0.05m)', () => {
		const c = cal();
		const gully = mapCameraPoint(c, { x: 250, y: 189 })!;
		const post = mapCameraPoint(c, { x: 462, y: 257 })!;
		const distPx = Math.hypot(post.x - gully.x, post.y - gully.y);
		const distM = distPx / c.mapScalePxPerM;
		expect(Math.abs(distM - 4.01)).toBeLessThanOrEqual(0.05);
	});

	it('scales analytics-frame detections (960x540) into the calibration frame', () => {
		// coord chosen so the foot point is (375, 283.5) in the analytics frame
		// = (250,189) * 1.5 in the calibration frame → same Gully map pixel.
		const coord: [number, number, number, number] = [365, 233.5, 20, 50];
		expect(footPoint(coord)).toEqual({ x: 375, y: 283.5 });
		const mapped = mapDetection(cal(), coord);
		expect(mapped).not.toBeNull();
		expect(Math.abs(mapped!.x - 72)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(mapped!.y - 431)).toBeLessThanOrEqual(0.5);
	});

	it('returns null for a point behind the camera (sky, w flips sign)', () => {
		// Calibration-frame (320,0) is well above the horizon: its undistorted
		// projective w is ~+3.64 vs. the Gully reference w ~-1.58 → sign flip.
		expect(mapCameraPoint(cal(), { x: 320, y: 0 })).toBeNull();
	});

	it('returns null for a near-horizon point (320,140) — |w| below 5% of anchor', () => {
		// w ≈ -0.0768 keeps the anchor sign but is only ~4.8% of the anchor's
		// |w| ≈ 1.584 → projective blow-up (would map to (-323,-2610) garbage).
		expect(mapCameraPoint(cal(), { x: 320, y: 140 })).toBeNull();
	});

	it('returns null for a point that maps outside the aerial image bounds', () => {
		// (320,150) passes BOTH w-guards (w ≈ -0.296, ~18.7% of anchor |w|,
		// correct sign) but maps to ≈(29,-259) — y < 0, outside 1101x823 → null.
		expect(mapCameraPoint(cal(), { x: 320, y: 150 })).toBeNull();
	});

	it('returns null when analytics/calibration frame aspects mismatch', () => {
		// 640/960 ≈ 0.6667 vs 360/544 ≈ 0.6618 — the uniform width-ratio scale
		// would distort the y axis, so mapDetection must reject the calibration.
		const broken: BirdeyeCalibration = { ...cal(), analyticsFrame: { width: 960, height: 544 } };
		const coord: [number, number, number, number] = [365, 233.5, 20, 50];
		expect(mapDetection(broken, coord)).toBeNull();
	});

	it('returns undefined for an unknown camera id', () => {
		expect(getBirdeyeCalibration('nope')).toBeUndefined();
	});
});
