// v1.3 Phase 19 Plan 03 — RED tests for protect-bridge.ts (lib boundary).
// Test contract is the source of truth for the implementation in Task 02.
// Fixtures live in ./__fixtures__/protect-bootstrap-*.json (project convention).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub $env/dynamic/private (settings.ts may reach for it transitively via crypto.ts).
vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// Hoisted mock state — the lib's `bootstrap` getter and methods resolve dynamically.
const { mockLogin, mockGetBootstrap, mockBootstrapRef, mockGetSettings } = vi.hoisted(() => ({
	mockLogin: vi.fn(),
	mockGetBootstrap: vi.fn(),
	mockBootstrapRef: { current: null as { cameras: unknown[] } | null },
	mockGetSettings: vi.fn()
}));

vi.mock('unifi-protect', () => ({
	ProtectApi: class {
		get bootstrap() {
			return mockBootstrapRef.current;
		}
		login = mockLogin;
		getBootstrap = mockGetBootstrap;
	}
}));

vi.mock('./settings', () => ({
	getSetting: vi.fn(),
	getSettings: mockGetSettings
}));

// Import AFTER mocks so the module sees the stubs.
import {
	classifyKind,
	deriveManufacturerHint,
	fetchBootstrap,
	normalizeMac,
	protectStreamUrl,
	resetProtectClient,
	TLS_SCHEME
} from './protect-bridge';

import firstPartyFixture from './__fixtures__/protect-bootstrap-first-party-3-channel.json' with {
	type: 'json'
};
import emptyFixture from './__fixtures__/protect-bootstrap-empty.json' with { type: 'json' };

const HAPPY_CREDS = {
	unifi_host: '192.0.2.1',
	unifi_username: 'admin',
	unifi_password: 'pw'
};

beforeEach(() => {
	resetProtectClient();
	mockLogin.mockReset();
	mockGetBootstrap.mockReset();
	mockBootstrapRef.current = null;
	mockGetSettings.mockReset();
	mockGetSettings.mockResolvedValue(HAPPY_CREDS);
});

describe('classifyKind', () => {
	it('returns first-party when isThirdPartyCamera === false', () => {
		expect(classifyKind({ isThirdPartyCamera: false } as never)).toBe('first-party');
	});
	it('returns third-party when isThirdPartyCamera === true', () => {
		expect(classifyKind({ isThirdPartyCamera: true } as never)).toBe('third-party');
	});
	it('returns unknown when isThirdPartyCamera is undefined', () => {
		expect(classifyKind({} as never)).toBe('unknown');
	});
	it('returns unknown when isThirdPartyCamera is null (defensive vs lib type drift)', () => {
		expect(classifyKind({ isThirdPartyCamera: null } as never)).toBe('unknown');
	});
});

describe('normalizeMac', () => {
	it('lowercases and strips colons', () => {
		expect(normalizeMac('AA:BB:CC:11:22:33')).toBe('aabbcc112233');
	});
	it('lowercases and strips dashes', () => {
		expect(normalizeMac('aa-bb-cc-11-22-33')).toBe('aabbcc112233');
	});
	it('passes through already-normalised', () => {
		expect(normalizeMac('aabbcc112233')).toBe('aabbcc112233');
	});
	it('handles empty', () => {
		expect(normalizeMac('')).toBe('');
	});
	it('handles separators-only', () => {
		expect(normalizeMac(':-:-')).toBe('');
	});
});

describe('TLS_SCHEME', () => {
	it('is exported and is one of the locked values', () => {
		expect(['rtspx', 'rtsps-tls-verify-0']).toContain(TLS_SCHEME);
	});
});

describe('protectStreamUrl', () => {
	it('builds an rtspx URL when scheme is rtspx', () => {
		if (TLS_SCHEME === 'rtspx') {
			expect(protectStreamUrl('192.0.2.1', 'abc1')).toBe(
				'rtspx://192.0.2.1:7441/abc1?enableSrtp'
			);
		}
	});
	it('builds an rtsps URL when scheme is rtsps-tls-verify-0', () => {
		if (TLS_SCHEME === 'rtsps-tls-verify-0') {
			expect(protectStreamUrl('192.0.2.1', 'abc1')).toMatch(/^rtsps:\/\//);
		}
	});
});

describe('deriveManufacturerHint', () => {
	it('returns Ubiquiti for first-party regardless of marketName', () => {
		expect(deriveManufacturerHint({ marketName: 'G4 Bullet' } as never, 'first-party')).toBe(
			'Ubiquiti'
		);
		expect(deriveManufacturerHint({ marketName: 'whatever' } as never, 'first-party')).toBe(
			'Ubiquiti'
		);
	});
	it('returns first marketName token for third-party', () => {
		expect(deriveManufacturerHint({ marketName: 'Mobotix S15' } as never, 'third-party')).toBe(
			'Mobotix'
		);
		expect(
			deriveManufacturerHint({ marketName: 'Hikvision DS-2CD2143G2' } as never, 'third-party')
		).toBe('Hikvision');
	});
	it('returns Unknown for unknown', () => {
		expect(deriveManufacturerHint({ marketName: 'Whatever' } as never, 'unknown')).toBe('Unknown');
	});
});

describe('fetchBootstrap', () => {
	it('returns controller_unreachable on ECONNREFUSED', async () => {
		mockLogin.mockRejectedValue(new Error('connect ECONNREFUSED 192.0.2.1:443'));
		const result = await fetchBootstrap();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('controller_unreachable');
	});

	it('returns controller_unreachable on ETIMEDOUT', async () => {
		mockLogin.mockRejectedValue(new Error('connect ETIMEDOUT 192.0.2.1:443'));
		const result = await fetchBootstrap();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('controller_unreachable');
	});

	it('returns auth_failed when creds not configured', async () => {
		mockGetSettings.mockResolvedValueOnce({}); // no unifi_host / username / password
		const result = await fetchBootstrap();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('auth_failed');
	});

	it('returns ok:true with cameras filtered to modelKey === "camera"', async () => {
		mockLogin.mockResolvedValue(true);
		mockGetBootstrap.mockResolvedValue(true);
		mockBootstrapRef.current = { cameras: firstPartyFixture };
		const result = await fetchBootstrap();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.cameras.length).toBeGreaterThan(0);
			for (const c of result.cameras) {
				expect(c.modelKey).toBe('camera');
			}
			// NVR row in the fixture must be filtered out.
			expect(result.cameras.find((c) => (c as { modelKey: string }).modelKey === 'nvr')).toBeUndefined();
		}
	});

	it('returns ok:true with empty array on empty fixture', async () => {
		mockLogin.mockResolvedValue(true);
		mockGetBootstrap.mockResolvedValue(true);
		mockBootstrapRef.current = { cameras: emptyFixture };
		const result = await fetchBootstrap();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.cameras).toEqual([]);
	});
});
