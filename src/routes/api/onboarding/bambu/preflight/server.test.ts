import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock $env/dynamic/private before importing anything that touches it.
vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// Preflight orchestrator — stub so we never actually hit TCP/MQTT/TLS in unit tests.
const runBambuPreflight = vi.fn();
vi.mock('$lib/server/services/bambu-preflight', () => ({
	runBambuPreflight: (...args: unknown[]) => (runBambuPreflight as any)(...args),
	realDeps: {}
}));

// Allowlist passthrough so model validation behaves predictably.
vi.mock('$lib/server/services/bambu-discovery', () => ({
	BAMBU_MODEL_ALLOWLIST: ['H2C', 'A1']
}));

import { POST } from './+server';

const post = async (body: unknown): Promise<Response> => {
	const request = new Request('http://localhost/api/onboarding/bambu/preflight', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	return (await (POST({ request } as any) as Promise<Response>)) as Response;
};

describe('POST /api/onboarding/bambu/preflight (Phase 18 / IN-01)', () => {
	beforeEach(() => {
		runBambuPreflight.mockReset();
	});

	it('400 when access code is 7 digits (too short)', async () => {
		const res = await post({
			ip: '192.0.2.109',
			serialNumber: '01P00A3B0700123',
			accessCode: '1234567' // 7 digits
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('INVALID_INPUT');
		expect(runBambuPreflight).not.toHaveBeenCalled();
	});

	it('400 when access code is 9 digits (too long)', async () => {
		const res = await post({
			ip: '192.0.2.109',
			serialNumber: '01P00A3B0700123',
			accessCode: '123456789' // 9 digits
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('INVALID_INPUT');
		expect(runBambuPreflight).not.toHaveBeenCalled();
	});
});
