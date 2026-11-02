// Bird-Eye M2 Slice 1 — PURE Detection-coord → Luftbild-Pixel mapping.
//
// Translates a Protect detection coordinate (`coord: [x,y,w,h]` in the camera's
// ANALYTICS frame) into an aerial/map pixel position via the per-camera
// calibration measured in the M0 spike (`.planning/spikes/birdeye-m0/`):
//   foot point → scale into the calibration frame → radial undistortion →
//   homography (projective) → map pixel.
//
// This module is deliberately I/O-free and side-effect-free (mirroring
// `detection-tap-fsm.ts`): no detection-pipeline wiring, no MQTT, no UI —
// those are Slice-2 concerns. Calibration data lives here as a TS constant
// for the single calibrated camera; a config mechanism (DB/file) is a
// deliberate non-goal for Slice 1.

/** Frame dimensions in pixels. */
export interface FrameSize {
	width: number;
	height: number;
}

/** 3x3 projective homography — fixed tuple shape, enforced at compile time. */
export type Homography3x3 = [
	[number, number, number],
	[number, number, number],
	[number, number, number]
];

/**
 * Per-camera calibration: maps a point in the camera's calibration frame
 * (the snapshot resolution the homography was fitted against) to aerial pixels.
 * Source of truth: `.planning/spikes/birdeye-m0/kalibrierung.json` — values are
 * copied 1:1 at full precision, never re-derived here.
 */
export interface BirdeyeCalibration {
	cameraId: string;
	/** Frame the undistortion + homography were calibrated in (snapshot res). */
	calibrationFrame: FrameSize;
	/** Frame Protect detection coords arrive in (analytics res). */
	analyticsFrame: FrameSize;
	/** Radial polynomial x_u = x_d * (1 + a*r² + b*r⁴), normalized around (cx,cy) by `norm`. */
	undistort: { a: number; b: number; cx: number; cy: number; norm: number };
	/** 3x3 homography: undistorted calibration-frame point → aerial pixel (projective). */
	homography: Homography3x3;
	/**
	 * A calibration-frame point known to lie ON the ground plane (for Auffahrt:
	 * the Gully). Defines the valid sign + magnitude reference of the projective
	 * w-component PER calibration — a second camera may legitimately have the
	 * opposite sign, so this must never be derived from another camera's anchor.
	 */
	groundAnchor: { x: number; y: number };
	/** Aerial image dimensions — mapped points outside [0,w)x[0,h) are invalid. */
	mapSize: FrameSize;
	/** Aerial image scale — pixels per meter on the ground plane. */
	mapScalePxPerM: number;
	/** Human hint where the aerial image lives (NOT loaded here — pure module). */
	mapImage: string;
}

// ── calibration registry ───────────────────────────────────────────────────────
// One camera for Slice 1 (Auffahrt). All numbers verbatim from the verified
// M0 spike of the author's installation (example values – recalibrate for
// your own camera and aerial image).
const AUFFAHRT_CALIBRATION: BirdeyeCalibration = {
	cameraId: '000000000000000000000001',
	calibrationFrame: { width: 640, height: 360 },
	analyticsFrame: { width: 960, height: 540 },
	undistort: {
		a: 0.24209486188798424,
		b: 0.949245519693633,
		cx: 320,
		cy: 180,
		norm: 320
	},
	homography: [
		[-0.34470346265878227, -3.3151436024691474, 598.6868245907203],
		[3.9294784704326458, -12.263081264970532, 657.8643857751974],
		[0.0061381268300946265, -0.021746455529529637, 1.0]
	],
	groundAnchor: { x: 250, y: 189 }, // Gully — verified ground-plane point (M0 oracle)
	mapSize: { width: 1101, height: 823 },
	mapScalePxPerM: 43.75,
	mapImage: 'static/birdeye/luftbild.jpg (1101x823, not shipped – bring your own aerial image)'
};

const CALIBRATIONS = new Map<string, BirdeyeCalibration>([
	[AUFFAHRT_CALIBRATION.cameraId, AUFFAHRT_CALIBRATION]
]);

/** Look up the calibration for a Protect camera id; undefined = camera not calibrated. */
export function getBirdeyeCalibration(cameraId: string): BirdeyeCalibration | undefined {
	return CALIBRATIONS.get(cameraId);
}

/** All registered calibrations (read-only enumeration for UI hints/endpoints). */
export function listBirdeyeCalibrations(): BirdeyeCalibration[] {
	return [...CALIBRATIONS.values()];
}

// ── mapping math ───────────────────────────────────────────────────────────────

/**
 * Foot point of a detection box `[x,y,w,h]` — bottom-center, the spot where the
 * subject touches the ground plane. Stays in whatever frame the box came in.
 */
export function footPoint(coord: [number, number, number, number]): { x: number; y: number } {
	const [x, y, w, h] = coord;
	return { x: x + w / 2, y: y + h };
}

/** Radial undistortion (forward only — cam→map never needs the inverse). */
function undistortPoint(
	cal: BirdeyeCalibration,
	p: { x: number; y: number }
): { x: number; y: number } {
	const { a, b, cx, cy, norm } = cal.undistort;
	const xn = (p.x - cx) / norm;
	const yn = (p.y - cy) / norm;
	const r2 = xn * xn + yn * yn;
	const f = 1 + a * r2 + b * r2 * r2;
	return { x: xn * f * norm + cx, y: yn * f * norm + cy };
}

/** Projective w-component of H·[x,y,1] for an undistorted point. */
function homogeneousW(cal: BirdeyeCalibration, u: { x: number; y: number }): number {
	const h = cal.homography;
	return h[2][0] * u.x + h[2][1] * u.y + h[2][2];
}

// Guards on the projective w-component. The reference is the calibration's own
// `groundAnchor` (a verified ground-plane point), derived PER calibration:
//  - sign flip vs. the anchor → point is behind the camera / across the horizon,
//  - |w| below HORIZON_W_FRACTION of the anchor's |w| → too close to the horizon
//    line; the projective division blows up and the map position is garbage
//    (e.g. Auffahrt (320,140): w ≈ -0.077 passes the sign check but would map
//    to (-323,-2610)).
const W_EPSILON = 1e-9;
const HORIZON_W_FRACTION = 0.05;

// Anchor w is a pure function of the (immutable) calibration — memoize per object.
const anchorWCache = new WeakMap<BirdeyeCalibration, number>();
function anchorW(cal: BirdeyeCalibration): number {
	let w = anchorWCache.get(cal);
	if (w === undefined) {
		w = homogeneousW(cal, undistortPoint(cal, cal.groundAnchor));
		anchorWCache.set(cal, w);
	}
	return w;
}

/**
 * Map a point in the CALIBRATION frame (e.g. 640x360 snapshot pixels) to an
 * aerial/map pixel. Returns `null` when the point is invalid:
 *  - behind the camera (w flips sign vs. the calibration's groundAnchor),
 *  - too close to the horizon (|w| < 5% of the anchor's |w| → blow-up),
 *  - mapped position outside the aerial image (strict [0,width)x[0,height) —
 *    mapSize is the source of truth for what the map covers; anything outside
 *    cannot be rendered and is treated as invalid, no tolerance margin).
 */
export function mapCameraPoint(
	cal: BirdeyeCalibration,
	p: { x: number; y: number }
): { x: number; y: number } | null {
	const aw = anchorW(cal);
	if (!Number.isFinite(aw) || Math.abs(aw) < W_EPSILON) return null; // degenerate calibration
	const u = undistortPoint(cal, p);
	const h = cal.homography;
	const w = homogeneousW(cal, u);
	// behind-camera + near-horizon guard (relative threshold subsumes |w| ~ 0).
	if (Math.abs(w) < HORIZON_W_FRACTION * Math.abs(aw) || Math.sign(w) !== Math.sign(aw)) {
		return null;
	}
	const x = (h[0][0] * u.x + h[0][1] * u.y + h[0][2]) / w;
	const y = (h[1][0] * u.x + h[1][1] * u.y + h[1][2]) / w;
	// out-of-map guard: result must land on the aerial image.
	if (x < 0 || x >= cal.mapSize.width || y < 0 || y >= cal.mapSize.height) return null;
	return { x, y };
}

/**
 * Map a Protect detection coord `[x,y,w,h]` (ANALYTICS frame) to an aerial
 * pixel: foot point → uniform scale into the calibration frame → mapCameraPoint.
 * A single factor (width ratio) is applied to BOTH axes — that is only valid
 * when calibration and analytics frame share the same aspect, so this is
 * VERIFIED instead of trusted: mismatching ratios mean broken calibration
 * data, and the point is rejected (`null`, consistent with the other
 * invalid-input paths) rather than silently distorted along one axis.
 */
export function mapDetection(
	cal: BirdeyeCalibration,
	coord: [number, number, number, number]
): { x: number; y: number } | null {
	const scaleX = cal.calibrationFrame.width / cal.analyticsFrame.width;
	const scaleY = cal.calibrationFrame.height / cal.analyticsFrame.height;
	if (Math.abs(scaleX - scaleY) > 1e-6) return null; // aspect mismatch = invalid calibration
	const foot = footPoint(coord);
	return mapCameraPoint(cal, { x: foot.x * scaleX, y: foot.y * scaleX });
}
