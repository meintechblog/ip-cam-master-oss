// C2 DetectionTap — behavior tests for the PURE FSM (Task 1) and the thin
// wrapper (Task 2). Mirrors `protect-connection-fsm.test.ts` style: deterministic,
// no real controller, no real timers — virtual time is advanced by reassigning an
// injected `now()` closure variable (preferred over fake timers to avoid unref
// edge cases). Fixtures deliberately carry PII fields (metadata/thumbnailId/
// smartDetectEvents) so the PII-drop assertion is real.

import { describe, it, expect } from 'vitest';
import {
	parseEventPacket,
	computeConfirmations,
	computeEnd,
	isCoolingDown,
	isOrphanExpired,
	cooldownKey,
	DEFAULT_CONFIRM_SCORE,
	DEFAULT_COOLDOWN_MS,
	DEFAULT_EVENT_TTL_MS,
	type EventState
} from './detection-tap-fsm';
import { DetectionTap, type MinimalEvent } from './detection-tap';

// ── fixture helper ─────────────────────────────────────────────────────────────
// Builds a realistic ProtectEventPacket, INCLUDING PII fields, so the structural
// drop is exercised end-to-end.
function makePacket(
	action: 'add' | 'update',
	opts: {
		id?: string;
		camera?: string;
		smartDetectTypes?: string[];
		score?: number;
		end?: number;
		modelKey?: string;
	} = {}
): unknown {
	return {
		header: {
			action,
			id: opts.id ?? 'evt-1',
			modelKey: opts.modelKey ?? 'event',
			newUpdateId: 'u-' + Math.random().toString(36).slice(2)
		},
		payload: {
			id: opts.id ?? 'evt-1',
			// Real Protect wire field is `camera` (verified against the live ws
			// 2026-06-10) — the earlier `cameraId` fixture never matched a real packet.
			camera: opts.camera ?? 'cam-A',
			smartDetectTypes: opts.smartDetectTypes ?? [],
			score: opts.score ?? 0,
			start: 1000,
			end: opts.end ?? 0,
			// ── PII / noise fields that MUST never reach a MinimalEvent ──
			metadata: { objectId: 'o-9', boundingBox: { x: 1, y: 2, w: 3, h: 4 } },
			thumbnailId: 'thumb-xyz',
			smartDetectEvents: ['sde-1', 'sde-2'],
			partition: 'p1',
			user: 'admin',
			detectedAt: 12345,
			type: 'smartDetectZone'
		}
	};
}

const PII_KEYS = [
	'metadata',
	'thumbnailId',
	'smartDetectEvents',
	'partition',
	'user',
	'detectedAt',
	'boundingBox',
	'start',
	'cameraId'
];

function assertMinimalShape(e: MinimalEvent): void {
	expect(Object.keys(e).sort()).toEqual(['camera', 'phase', 'score', 'ts', 'type']);
	for (const k of PII_KEYS) {
		expect(Object.prototype.hasOwnProperty.call(e, k)).toBe(false);
	}
}

// A tap whose clock we control by reassigning `clock.t`.
function makeTap(overrides: Partial<ConstructorParameters<typeof DetectionTap>[0]> = {}) {
	const clock = { t: 0 };
	const events: MinimalEvent[] = [];
	const tap = new DetectionTap({ now: () => clock.t, ...overrides });
	tap.onDetection((e) => events.push(e));
	return { tap, clock, events };
}

// ── pure FSM: parseEventPacket ──────────────────────────────────────────────────
describe('parseEventPacket (PII gate)', () => {
	it("returns null for a non-'event' modelKey", () => {
		expect(parseEventPacket(makePacket('add', { modelKey: 'camera' }))).toBeNull();
		expect(parseEventPacket(makePacket('add', { modelKey: 'nvr' }))).toBeNull();
	});

	it('returns null for malformed packets (null / missing payload / missing id)', () => {
		expect(parseEventPacket(null)).toBeNull();
		expect(parseEventPacket({})).toBeNull();
		expect(parseEventPacket({ header: { modelKey: 'event' } })).toBeNull();
		expect(parseEventPacket({ header: { modelKey: 'event' }, payload: {} })).toBeNull();
	});

	it('copies ONLY id/camera/smartDetectTypes/score/end — never PII', () => {
		const parsed = parseEventPacket(
			makePacket('add', { smartDetectTypes: ['person'], score: 80, end: 0 })
		);
		expect(parsed).not.toBeNull();
		expect(Object.keys(parsed!).sort()).toEqual(['camera', 'end', 'id', 'isEvent', 'score', 'types']);
		expect(parsed!.camera).toBe('cam-A');
		expect(parsed!.types).toEqual(['person']);
		expect(parsed!.score).toBe(80);
	});

	// Regression (2026-06-10): the real Protect ws carries the camera id under
	// `camera`, NOT `cameraId`. Reading `cameraId` made parseEventPacket drop EVERY
	// live event (camera='' → null) while synthetic `cameraId` fixtures passed —
	// the whole tap silently caught nothing in production. This fixture is the
	// exact shape observed on the live wire.
	it('parses a real-wire smartDetectZone packet (field is `camera`, not `cameraId`)', () => {
		const realWire = {
			header: { action: 'add', id: 'e-real', modelKey: 'event' },
			payload: {
				id: 'e-real',
				type: 'smartDetectZone',
				camera: '000000000000000000000002',
				smartDetectTypes: ['vehicle'],
				score: 54,
				start: 1781083587307
			}
		};
		const parsed = parseEventPacket(realWire);
		expect(parsed).not.toBeNull();
		expect(parsed!.camera).toBe('000000000000000000000002');
		expect(parsed!.types).toEqual(['vehicle']);
		expect(parsed!.score).toBe(54);
	});

	it('still parses a legacy `cameraId`-only packet via fallback', () => {
		const legacy = {
			header: { action: 'add', id: 'e-legacy', modelKey: 'event' },
			payload: { id: 'e-legacy', cameraId: 'cam-Z', smartDetectTypes: ['person'], score: 60 }
		};
		expect(parseEventPacket(legacy)?.camera).toBe('cam-Z');
	});
});

// ── pure FSM: confirmations / end / cooldown / reaper predicates ─────────────────
describe('computeConfirmations', () => {
	it('confirms a single type on first sighting when score clears the gate', () => {
		const parsed = parseEventPacket(makePacket('add', { smartDetectTypes: ['person'], score: 60 }))!;
		const { nextState, emit } = computeConfirmations(undefined, parsed, 100, DEFAULT_CONFIRM_SCORE);
		expect(emit).toHaveLength(1);
		expect(emit[0]).toMatchObject({ camera: 'cam-A', type: 'person', phase: 'confirmed', score: 60, ts: 100 });
		expect(nextState.confirmedTypes.has('person')).toBe(true);
	});

	it('does not confirm below the score gate, but stays eligible for a later update', () => {
		const weak = parseEventPacket(makePacket('add', { smartDetectTypes: ['person'], score: 10 }))!;
		const r1 = computeConfirmations(undefined, weak, 100, DEFAULT_CONFIRM_SCORE);
		expect(r1.emit).toHaveLength(0);
		expect(r1.nextState.confirmedTypes.has('person')).toBe(false);

		const strong = parseEventPacket(makePacket('update', { smartDetectTypes: ['person'], score: 70 }))!;
		const r2 = computeConfirmations(r1.nextState, strong, 200, DEFAULT_CONFIRM_SCORE);
		expect(r2.emit).toHaveLength(1);
		expect(r2.emit[0].type).toBe('person');
	});

	it('emits exactly one new confirmed event when the type set grows', () => {
		const a = parseEventPacket(makePacket('add', { smartDetectTypes: ['person'], score: 70 }))!;
		const r1 = computeConfirmations(undefined, a, 100, DEFAULT_CONFIRM_SCORE);
		expect(r1.emit.map((e) => e.type)).toEqual(['person']);

		const b = parseEventPacket(makePacket('update', { smartDetectTypes: ['person', 'package'], score: 75 }))!;
		const r2 = computeConfirmations(r1.nextState, b, 200, DEFAULT_CONFIRM_SCORE);
		expect(r2.emit.map((e) => e.type)).toEqual(['package']); // person NOT re-emitted
	});

	it('dedups repeated updates (no re-emit of an already-confirmed type)', () => {
		const a = parseEventPacket(makePacket('add', { smartDetectTypes: ['person'], score: 70 }))!;
		let state = computeConfirmations(undefined, a, 100, DEFAULT_CONFIRM_SCORE).nextState;
		for (let i = 0; i < 3; i++) {
			const u = parseEventPacket(makePacket('update', { smartDetectTypes: ['person'], score: 72 }))!;
			const r = computeConfirmations(state, u, 200 + i, DEFAULT_CONFIRM_SCORE);
			expect(r.emit).toHaveLength(0);
			state = r.nextState;
		}
	});

	it('does not mutate its input state (pure)', () => {
		const seed: EventState = {
			camera: 'cam-A',
			confirmedTypes: new Set<string>(),
			lastScore: 0,
			firstSeen: 0,
			lastSeen: 0,
			ended: false
		};
		const parsed = parseEventPacket(makePacket('add', { smartDetectTypes: ['person'], score: 70 }))!;
		computeConfirmations(seed, parsed, 100, DEFAULT_CONFIRM_SCORE);
		expect(seed.confirmedTypes.size).toBe(0);
		expect(seed.lastScore).toBe(0);
	});
});

describe('computeEnd', () => {
	it('emits one ended event per confirmed type, with the last known score', () => {
		const state: EventState = {
			camera: 'cam-A',
			confirmedTypes: new Set(['person', 'package']),
			lastScore: 88,
			firstSeen: 0,
			lastSeen: 50,
			ended: false
		};
		const { nextState, emit } = computeEnd(state, 500);
		expect(emit).toHaveLength(2);
		for (const e of emit) {
			expect(e.phase).toBe('ended');
			expect(e.score).toBe(88);
			expect(e.ts).toBe(500);
		}
		expect(nextState.ended).toBe(true);
	});

	it('emits nothing for an event that never confirmed a type', () => {
		const state: EventState = {
			camera: 'cam-A',
			confirmedTypes: new Set<string>(),
			lastScore: 5,
			firstSeen: 0,
			lastSeen: 10,
			ended: false
		};
		const { nextState, emit } = computeEnd(state, 500);
		expect(emit).toHaveLength(0);
		expect(nextState.ended).toBe(true);
	});
});

describe('isCoolingDown / isOrphanExpired / cooldownKey / tunables', () => {
	it('isCoolingDown respects the window and a missing lastEmit', () => {
		expect(isCoolingDown(undefined, 1000, 30_000)).toBe(false);
		expect(isCoolingDown(1000, 1000 + 29_999, 30_000)).toBe(true);
		expect(isCoolingDown(1000, 1000 + 30_000, 30_000)).toBe(false);
	});

	it('isOrphanExpired only when not ended and silent past ttl', () => {
		const live: EventState = { camera: 'c', confirmedTypes: new Set(), lastScore: 0, firstSeen: 0, lastSeen: 1000, ended: false };
		expect(isOrphanExpired(live, 1000 + 119_999, 120_000)).toBe(false);
		expect(isOrphanExpired(live, 1000 + 120_000, 120_000)).toBe(true);
		const ended: EventState = { ...live, ended: true };
		expect(isOrphanExpired(ended, 1000 + 999_999, 120_000)).toBe(false);
	});

	it('cooldownKey joins camera and type with a single space', () => {
		expect(cooldownKey('cam-A', 'person')).toBe('cam-A person');
	});

	it('exports the documented tunables', () => {
		expect(DEFAULT_CONFIRM_SCORE).toBe(50);
		expect(DEFAULT_COOLDOWN_MS).toBe(30_000);
		expect(DEFAULT_EVENT_TTL_MS).toBe(120_000);
	});
});

// ── wrapper: DetectionTap end-to-end via ingest()/reap() ─────────────────────────
describe('DetectionTap wrapper', () => {
	it('1. add(person, score>=confirm) emits confirmed/person exactly once', () => {
		const { tap, clock, events } = makeTap();
		clock.t = 100;
		tap.ingest(makePacket('add', { smartDetectTypes: ['person'], score: 60 }));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: 'person', phase: 'confirmed' });
	});

	it('2. confirm requires the score gate (weak add silent, strong update confirms)', () => {
		const { tap, clock, events } = makeTap();
		clock.t = 100;
		tap.ingest(makePacket('add', { smartDetectTypes: ['person'], score: 10 }));
		expect(events).toHaveLength(0);
		clock.t = 200;
		tap.ingest(makePacket('update', { smartDetectTypes: ['person'], score: 70 }));
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('person');
	});

	it('3. growing types emit exactly one new confirmed (person not re-emitted)', () => {
		const { tap, clock, events } = makeTap();
		clock.t = 100;
		tap.ingest(makePacket('add', { smartDetectTypes: ['person'], score: 70 }));
		clock.t = 200;
		tap.ingest(makePacket('update', { smartDetectTypes: ['person', 'package'], score: 75 }));
		expect(events.map((e) => e.type)).toEqual(['person', 'package']);
	});

	it('4. dedup: repeated update(person) packets after confirm emit nothing more', () => {
		const { tap, clock, events } = makeTap();
		clock.t = 100;
		tap.ingest(makePacket('add', { smartDetectTypes: ['person'], score: 70 }));
		for (let i = 0; i < 3; i++) {
			clock.t = 200 + i;
			tap.ingest(makePacket('update', { smartDetectTypes: ['person'], score: 72 }));
		}
		expect(events).toHaveLength(1);
	});

	it('5. end!=0 emits ended/person (last score) and removes the event state', () => {
		const { tap, clock, events } = makeTap();
		clock.t = 100;
		tap.ingest(makePacket('add', { smartDetectTypes: ['person'], score: 70 }));
		clock.t = 300;
		tap.ingest(makePacket('update', { smartDetectTypes: ['person'], score: 84, end: 5000 }));
		const ended = events.filter((e) => e.phase === 'ended');
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({ type: 'person', score: 84, ts: 300 });
		// state freed → a subsequent add with the same id confirms again (would not if stuck)
		clock.t = 100_000; // past cooldown
		tap.ingest(makePacket('add', { smartDetectTypes: ['person'], score: 70 }));
		expect(events.filter((e) => e.phase === 'confirmed')).toHaveLength(2);
	});

	it('6. cooldown per (camera,type): same (cam,type) suppressed, other type not; recovers after window', () => {
		const { tap, clock, events } = makeTap({ cooldownMs: DEFAULT_COOLDOWN_MS });
		clock.t = 1000;
		tap.ingest(makePacket('add', { id: 'e1', camera: 'camA', smartDetectTypes: ['person'], score: 70 }));
		expect(events.filter((e) => e.type === 'person')).toHaveLength(1);

		// new event id, same (camA, person), within cooldown → suppressed
		clock.t = 1000 + 5_000;
		tap.ingest(makePacket('add', { id: 'e2', camera: 'camA', smartDetectTypes: ['person'], score: 70 }));
		expect(events.filter((e) => e.type === 'person')).toHaveLength(1); // still 1

		// same window, different type (vehicle) → NOT suppressed
		clock.t = 1000 + 6_000;
		tap.ingest(makePacket('add', { id: 'e3', camera: 'camA', smartDetectTypes: ['vehicle'], score: 70 }));
		expect(events.filter((e) => e.type === 'vehicle')).toHaveLength(1);

		// advance beyond cooldown → (camA, person) emits again
		clock.t = 1000 + DEFAULT_COOLDOWN_MS + 1;
		tap.ingest(makePacket('add', { id: 'e4', camera: 'camA', smartDetectTypes: ['person'], score: 70 }));
		expect(events.filter((e) => e.type === 'person')).toHaveLength(2);
	});

	it('7. TTL reaper: orphan with confirmed type → synthetic ended + state freed; unconfirmed orphan freed silently', () => {
		const { tap, clock, events } = makeTap({ eventTtlMs: DEFAULT_EVENT_TTL_MS });
		clock.t = 1000;
		tap.ingest(makePacket('add', { id: 'orphan-1', smartDetectTypes: ['person'], score: 70 }));
		// an orphan that never confirmed (below score gate)
		tap.ingest(makePacket('add', { id: 'orphan-2', camera: 'camB', smartDetectTypes: ['animal'], score: 5 }));

		clock.t = 1000 + DEFAULT_EVENT_TTL_MS + 1;
		tap.reap();

		const ended = events.filter((e) => e.phase === 'ended');
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({ type: 'person', phase: 'ended' });

		// both states freed — reaping again emits nothing
		const before = events.length;
		clock.t += 1;
		tap.reap();
		expect(events.length).toBe(before);
	});

	it('8. PII drop: every emitted MinimalEvent has EXACTLY {camera,type,phase,score,ts}', () => {
		const { tap, clock, events } = makeTap();
		clock.t = 100;
		tap.ingest(makePacket('add', { smartDetectTypes: ['person'], score: 70 }));
		clock.t = 300;
		tap.ingest(makePacket('update', { smartDetectTypes: ['person'], score: 90, end: 9000 }));
		expect(events.length).toBeGreaterThanOrEqual(2);
		for (const e of events) assertMinimalShape(e);
	});

	it('9. non-event modelKey + malformed packets are ignored without throwing', () => {
		const { tap, clock, events } = makeTap();
		clock.t = 100;
		tap.ingest(makePacket('add', { modelKey: 'camera', smartDetectTypes: ['person'], score: 90 }));
		tap.ingest(makePacket('update', { modelKey: 'nvr', smartDetectTypes: ['person'], score: 90 }));
		expect(() => tap.ingest(null)).not.toThrow();
		expect(() => tap.ingest({ header: {}, payload: null })).not.toThrow();
		expect(events).toHaveLength(0);
	});

	it('attaches to a C1-style packet source and stop() clears the reaper without leaking', () => {
		const { tap, events } = makeTap({ reaperIntervalMs: 1000 });
		let captured: ((p: unknown) => void) | null = null;
		tap.attach({ onPacket: (l) => (captured = l) });
		expect(typeof captured).toBe('function');
		captured!(makePacket('add', { smartDetectTypes: ['person'], score: 70 }));
		expect(events).toHaveLength(1);
		expect(() => tap.stop()).not.toThrow();
	});
});
