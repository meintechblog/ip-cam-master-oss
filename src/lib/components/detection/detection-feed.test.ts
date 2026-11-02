// Quick-task 260610-cw6 Task 1 — tests for the C4 lean detection UI presentational layer.
//
// Test strategy (deviation from PLAN, see SUMMARY "Deviations"): this repo has NO
// @testing-library/svelte and NO jsdom, and the task constraints forbid adding deps.
// The established convention here (ExternalCamCard.test.ts / tabs.test.ts: "Regex-
// against-source per Shared 6 — no jsdom for Svelte") is source-regex + pure-logic
// tests. So the banner-state machine and the type->icon mapping live in a tiny pure
// module (detection-feed-view.ts) that we exercise DIRECTLY (real behavior, not a
// string match), and the two .svelte components are asserted via source-regex that
// they consume that logic + render the required German labels. This proves the four
// behaviors the PLAN's tests require without introducing a new dependency.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	bannerState,
	iconNameForType,
	phaseLabel,
	QUIET_THRESHOLD_MS,
	type BannerKind
} from './detection-feed-view';

const NOW = 1_700_000_000_000;

describe('bannerState — C5 liveness semantics (quiet != disconnected)', () => {
	it('Test 1: disconnected -> red kind with the "Nicht verbunden" label, NOT the quiet label', () => {
		const s = bannerState('disconnected', null, NOW);
		expect(s.kind).toBe<BannerKind>('disconnected');
		expect(s.tone).toBe('red');
		expect(s.label).toMatch(/Nicht verbunden/);
		expect(s.label).not.toMatch(/ruhig/);
	});

	it('degraded -> yellow kind with the reconnecting label', () => {
		const s = bannerState('degraded', NOW, NOW);
		expect(s.kind).toBe<BannerKind>('degraded');
		expect(s.tone).toBe('yellow');
		expect(s.label).toMatch(/Wiederverbindung läuft/);
	});

	it('Test 2: connected + lastEventAt null -> QUIET label, distinct from disconnected', () => {
		const s = bannerState('connected', null, NOW);
		expect(s.kind).toBe<BannerKind>('quiet');
		// quiet must NOT be the disconnected kind/tone, and must NOT carry an alarm look
		expect(s.kind).not.toBe('disconnected');
		expect(s.tone).not.toBe('red');
		expect(s.label).toMatch(/ruhig/);
		expect(s.label).not.toMatch(/Nicht verbunden/);
	});

	it('connected but last event older than the quiet threshold -> quiet', () => {
		const stale = NOW - QUIET_THRESHOLD_MS - 1;
		const s = bannerState('connected', stale, NOW);
		expect(s.kind).toBe<BannerKind>('quiet');
		expect(s.label).toMatch(/ruhig/);
	});

	it('Test 3: connected + lastEventAt = now -> active label', () => {
		const s = bannerState('connected', NOW, NOW);
		expect(s.kind).toBe<BannerKind>('active');
		expect(s.tone).toBe('green');
		expect(s.label).toMatch(/aktiv/);
	});
});

describe('iconNameForType — open string set, safe default (T-cw6-02)', () => {
	it('maps known types to their lucide icon name', () => {
		expect(iconNameForType('person')).toBe('User');
		expect(iconNameForType('vehicle')).toBe('Car');
		expect(iconNameForType('animal')).toBe('PawPrint');
		expect(iconNameForType('package')).toBe('Package');
	});
	it('maps an unknown/untrusted type to the Eye default (never executes it)', () => {
		expect(iconNameForType('something-weird')).toBe('Eye');
		expect(iconNameForType('')).toBe('Eye');
	});
});

describe('phaseLabel — German phase badges', () => {
	it('confirmed -> bestätigt, ended -> beendet', () => {
		expect(phaseLabel('confirmed')).toBe('bestätigt');
		expect(phaseLabel('ended')).toBe('beendet');
	});
});

describe('DetectionHealthBanner.svelte source — wires bannerState + tones', () => {
	const src = readFileSync(
		resolve('src/lib/components/detection/DetectionHealthBanner.svelte'),
		'utf8'
	);
	it('imports and uses the shared bannerState logic (no duplicated state machine)', () => {
		expect(src).toMatch(/bannerState/);
		expect(src).toMatch(/from\s+['"]\.\/detection-feed-view['"]/);
	});
	it('renders all four tone token classes so quiet is visually distinct', () => {
		expect(src).toMatch(/text-red-400/);
		expect(src).toMatch(/text-yellow-400/);
		expect(src).toMatch(/text-green-400/);
		// quiet uses a muted/secondary tone distinct from the active green alarm look
		expect(src).toMatch(/text-text-secondary/);
	});
	it('takes a now prop defaulting to Date.now() for deterministic quiet logic', () => {
		expect(src).toMatch(/now\s*=\s*Date\.now\(\)/);
	});
});

describe('DetectionFeedItem.svelte source — renders MinimalEvent fields only (T-cw6-01)', () => {
	const src = readFileSync(
		resolve('src/lib/components/detection/DetectionFeedItem.svelte'),
		'utf8'
	);
	it('Test 4: renders camera, phase badge and score from the event', () => {
		expect(src).toMatch(/event\.camera/);
		expect(src).toMatch(/event\.score/);
		expect(src).toMatch(/phaseLabel/);
	});
	it('uses the icon map + auto-escaped text (no {@html}, no bbox/thumbnail/frame)', () => {
		expect(src).toMatch(/iconNameForType/);
		expect(src).not.toMatch(/\{@html/);
		expect(src).not.toMatch(/thumbnail|bbox|boundingBox|frame/i);
	});
	it('renders a relative/absolute time from event.ts', () => {
		expect(src).toMatch(/event\.ts/);
	});
});
