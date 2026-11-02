import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 24: version.ts now reads from the generated $lib/version.ts.
// Mock that module so we can drive the dev/prod branch deterministically.
vi.mock('$lib/version', () => ({
	CURRENT_SHA: '',
	CURRENT_SHA_SHORT: '',
	BUILD_TIME: '2026-01-01T00:00:00.000Z'
}));

import {
	parseDescribe,
	formatVersionLabel,
	getCurrentVersion,
	resetVersionCacheForTests,
	type VersionInfo
} from './version';

describe('parseDescribe', () => {
	it('parses tag + parent count + sha', () => {
		expect(parseDescribe('v0.1.0-5-gabc1234')).toEqual({
			tag: 'v0.1.0',
			sha: 'abc1234',
			isDirty: false
		});
	});

	it('parses bare short sha', () => {
		expect(parseDescribe('abc1234')).toEqual({
			tag: null,
			sha: 'abc1234',
			isDirty: false
		});
	});

	it('parses bare short sha with dirty suffix', () => {
		expect(parseDescribe('abc1234-dirty')).toEqual({
			tag: null,
			sha: 'abc1234',
			isDirty: true
		});
	});

	it('parses tag-only with dirty suffix', () => {
		expect(parseDescribe('v1.2.3-dirty')).toEqual({
			tag: 'v1.2.3',
			sha: null,
			isDirty: true
		});
	});

	it('parses tag + parent count + sha with dirty', () => {
		expect(parseDescribe('v0.1.0-5-gabc1234-dirty')).toEqual({
			tag: 'v0.1.0',
			sha: 'abc1234',
			isDirty: true
		});
	});

	it('returns empty parse for garbage input', () => {
		expect(parseDescribe('not-a-valid-thing')).toEqual({
			tag: null,
			sha: null,
			isDirty: false
		});
	});
});

describe('formatVersionLabel', () => {
	const base: VersionInfo = {
		version: '',
		sha: 'abc1234',
		tag: null,
		isDev: false,
		isDirty: false
	};

	it('formats tag + sha', () => {
		expect(formatVersionLabel({ ...base, tag: 'v0.1.0', sha: 'abc1234' })).toBe('v0.1.0 (abc1234)');
	});

	it('formats bare sha as main @ sha', () => {
		expect(formatVersionLabel({ ...base, tag: null, sha: 'abc1234' })).toBe('main @ abc1234');
	});

	it('returns dev when isDev is true', () => {
		expect(formatVersionLabel({ ...base, isDev: true, sha: 'unknown' })).toBe('dev');
	});

	it('formats tag only when sha is missing', () => {
		expect(formatVersionLabel({ ...base, tag: 'v1.2.3', sha: '' })).toBe('v1.2.3');
	});

	it('formats dev even when tag + sha present', () => {
		expect(formatVersionLabel({ ...base, isDev: true, tag: 'v1.0.0', sha: 'abc1234' })).toBe('dev');
	});
});

describe('getCurrentVersion', () => {
	beforeEach(() => {
		resetVersionCacheForTests();
	});

	it('returns dev fallback when CURRENT_SHA is empty (fresh checkout, no git)', async () => {
		const info = await getCurrentVersion();
		expect(info.isDev).toBe(true);
		expect(info.sha).toBe('unknown');
		expect(info.version).toBe('dev');
	});

	it('caches the result across subsequent calls', async () => {
		const first = await getCurrentVersion();
		const second = await getCurrentVersion();
		expect(first).toBe(second);
	});
});
