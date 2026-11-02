import { describe, it, expect, vi } from 'vitest';
import {
	runBambuPreflight,
	PREFLIGHT_HINTS_DE,
	type PreflightDeps
} from './bambu-preflight';

/**
 * Preflight orchestrator tests (Phase 11 original suite + Phase 18 / BAMBU-A1-04
 * model-split cases).
 *
 * NOTE on per-port `checkTcp` semantics: post-Plan-18-04 the orchestrator calls
 * `checkTcp` twice on the H2C path — first for MQTT (8883, universal
 * reachability), then for RTSPS (322, LAN-Mode gate). Tests that simulate a
 * port-322 failure now stub `checkTcp` with a per-port implementation so we
 * don't accidentally regress the MQTT-port probe to "LAN_MODE_OFF".
 */
function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
	return {
		checkTcp: vi.fn(async () => ({ ok: true as const })),
		checkRtsps: vi.fn(async () => ({ ok: true as const })),
		checkMqtt: vi.fn(async () => ({ ok: true as const })),
		checkTls6000: vi.fn(async () => ({ ok: true as const })),
		checkTutkDisabled: vi.fn(async () => ({ ok: true as const })),
		...overrides
	};
}

const INPUT = { ip: '192.0.2.109', serialNumber: '01P00A3B0700123', accessCode: '12345678' };

describe('runBambuPreflight orchestrator (H2C default — backward compat)', () => {
	it('returns { ok: true } when all three checks pass', async () => {
		const deps = makeDeps();
		const result = await runBambuPreflight(INPUT, deps);
		expect(result).toEqual({ ok: true });
		// MQTT port 8883 + RTSPS port 322 → 2 checkTcp calls on the H2C path
		expect(deps.checkTcp).toHaveBeenCalledTimes(2);
		expect(deps.checkRtsps).toHaveBeenCalledTimes(1);
		expect(deps.checkMqtt).toHaveBeenCalledTimes(1);
		// A1-only probes must NOT run on the H2C path
		expect(deps.checkTls6000).not.toHaveBeenCalled();
		expect(deps.checkTutkDisabled).not.toHaveBeenCalled();
	});

	it('returns PRINTER_UNREACHABLE and short-circuits when MQTT TCP (8883) times out', async () => {
		const deps = makeDeps({
			checkTcp: vi.fn(async () => ({ ok: false as const, reason: 'TIMEOUT' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps);
		expect(result).toEqual({
			ok: false,
			error: 'PRINTER_UNREACHABLE',
			hint: PREFLIGHT_HINTS_DE.PRINTER_UNREACHABLE
		});
		expect(deps.checkRtsps).not.toHaveBeenCalled();
		expect(deps.checkMqtt).not.toHaveBeenCalled();
	});

	it('returns LAN_MODE_OFF when RTSPS port 322 is refused (MQTT 8883 up)', async () => {
		const deps = makeDeps({
			checkTcp: vi.fn(async (_ip: string, port: number) =>
				port === 322
					? ({ ok: false as const, reason: 'REFUSED' as const })
					: ({ ok: true as const })
			)
		});
		const result = await runBambuPreflight(INPUT, deps);
		expect(result).toEqual({
			ok: false,
			error: 'LAN_MODE_OFF',
			hint: PREFLIGHT_HINTS_DE.LAN_MODE_OFF
		});
		expect(deps.checkRtsps).not.toHaveBeenCalled();
		expect(deps.checkMqtt).not.toHaveBeenCalled();
	});

	it('maps RTSPS AUTH → WRONG_ACCESS_CODE and skips MQTT', async () => {
		const deps = makeDeps({
			checkRtsps: vi.fn(async () => ({ ok: false as const, reason: 'AUTH' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps);
		expect(result).toMatchObject({ ok: false, error: 'WRONG_ACCESS_CODE' });
		expect(deps.checkMqtt).not.toHaveBeenCalled();
	});

	it('maps RTSPS REFUSED → LAN_MODE_OFF', async () => {
		const deps = makeDeps({
			checkRtsps: vi.fn(async () => ({ ok: false as const, reason: 'REFUSED' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps);
		expect(result).toMatchObject({ ok: false, error: 'LAN_MODE_OFF' });
	});

	it('maps RTSPS TIMEOUT → RTSPS_HANDSHAKE_HUNG with Live555 hint', async () => {
		const deps = makeDeps({
			checkRtsps: vi.fn(async () => ({ ok: false as const, reason: 'TIMEOUT' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe('RTSPS_HANDSHAKE_HUNG');
		expect(result.hint.toLowerCase()).toMatch(/live555|aus- und wieder einschalten/);
	});

	it('maps MQTT TIMEOUT → LAN_MODE_OFF', async () => {
		const deps = makeDeps({
			checkMqtt: vi.fn(async () => ({ ok: false as const, reason: 'TIMEOUT' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps);
		expect(result).toMatchObject({ ok: false, error: 'LAN_MODE_OFF' });
	});

	it('maps MQTT AUTH → WRONG_ACCESS_CODE', async () => {
		const deps = makeDeps({
			checkMqtt: vi.fn(async () => ({ ok: false as const, reason: 'AUTH' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps);
		expect(result).toMatchObject({ ok: false, error: 'WRONG_ACCESS_CODE' });
	});

	it('PREFLIGHT_HINTS_DE has German copy for all error codes', () => {
		expect(Object.keys(PREFLIGHT_HINTS_DE).sort()).toEqual([
			'A1_CAMERA_DISABLED',
			'A1_CLOUD_MODE_ACTIVE',
			'LAN_MODE_OFF',
			'PRINTER_UNREACHABLE',
			'RTSPS_HANDSHAKE_HUNG',
			'WRONG_ACCESS_CODE'
		]);
		for (const hint of Object.values(PREFLIGHT_HINTS_DE)) {
			expect(hint.length).toBeGreaterThan(10);
		}
	});
});

describe('runBambuPreflight — A1 model-split (Phase 18 / BAMBU-A1-04, BAMBU-A1-05)', () => {
	it('A1 happy path: runs TLS:6000 + TUTK, skips RTSPS entirely', async () => {
		const deps = makeDeps();
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result).toEqual({ ok: true });
		// MQTT port 8883 is the only checkTcp call on A1 path
		expect(deps.checkTcp).toHaveBeenCalledTimes(1);
		expect(deps.checkTcp).toHaveBeenCalledWith('192.0.2.109', 8883, expect.any(Number));
		// A1 probes
		expect(deps.checkTls6000).toHaveBeenCalledTimes(1);
		expect(deps.checkMqtt).toHaveBeenCalledTimes(1);
		expect(deps.checkTutkDisabled).toHaveBeenCalledTimes(1);
		// RTSPS never runs on A1
		expect(deps.checkRtsps).not.toHaveBeenCalled();
	});

	it('A1 TLS:6000 REFUSED → PRINTER_UNREACHABLE', async () => {
		const deps = makeDeps({
			checkTls6000: vi.fn(async () => ({ ok: false as const, reason: 'REFUSED' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result).toMatchObject({ ok: false, error: 'PRINTER_UNREACHABLE' });
		expect(deps.checkMqtt).not.toHaveBeenCalled();
		expect(deps.checkTutkDisabled).not.toHaveBeenCalled();
	});

	it('A1 TLS:6000 AUTH_REJECTED → WRONG_ACCESS_CODE', async () => {
		const deps = makeDeps({
			checkTls6000: vi.fn(async () => ({
				ok: false as const,
				reason: 'AUTH_REJECTED' as const
			}))
		});
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result).toMatchObject({ ok: false, error: 'WRONG_ACCESS_CODE' });
		expect(deps.checkMqtt).not.toHaveBeenCalled();
		expect(deps.checkTutkDisabled).not.toHaveBeenCalled();
	});

	it('A1 TLS:6000 CAMERA_DISABLED → A1_CAMERA_DISABLED with Bambu-app hint', async () => {
		// New diagnostic — distinguishes "camera switch is off in Bambu Handy"
		// from "wrong access code" so the user is told to fix the right thing.
		const deps = makeDeps({
			checkTls6000: vi.fn(async () => ({
				ok: false as const,
				reason: 'CAMERA_DISABLED' as const
			}))
		});
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result).toMatchObject({ ok: false, error: 'A1_CAMERA_DISABLED' });
		expect((result as { hint: string }).hint).toContain('Bambu Handy');
		expect(deps.checkMqtt).not.toHaveBeenCalled();
		expect(deps.checkTutkDisabled).not.toHaveBeenCalled();
	});

	it('A1 TLS:6000 TLS_HANDSHAKE → PRINTER_UNREACHABLE', async () => {
		const deps = makeDeps({
			checkTls6000: vi.fn(async () => ({
				ok: false as const,
				reason: 'TLS_HANDSHAKE' as const
			}))
		});
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result).toMatchObject({ ok: false, error: 'PRINTER_UNREACHABLE' });
	});

	it('A1 TUTK enabled → A1_CLOUD_MODE_ACTIVE with exact German hint', async () => {
		const deps = makeDeps({
			checkTutkDisabled: vi.fn(async () => ({
				ok: false as const,
				reason: 'ENABLED' as const
			}))
		});
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe('A1_CLOUD_MODE_ACTIVE');
		expect(result.hint).toMatch(/Cloud-Modus ist aktiv/);
		expect(result.hint).toMatch(/Bambu Handy App/);
		expect(result.hint).toMatch(/LAN Mode only/);
	});

	it('A1 TUTK TIMEOUT → A1_CLOUD_MODE_ACTIVE (conservative default — user must confirm state)', async () => {
		const deps = makeDeps({
			checkTutkDisabled: vi.fn(async () => ({
				ok: false as const,
				reason: 'TIMEOUT' as const
			}))
		});
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result).toMatchObject({ ok: false, error: 'A1_CLOUD_MODE_ACTIVE' });
	});

	it('A1 MQTT AUTH → WRONG_ACCESS_CODE (never surfaces as A1_CLOUD_MODE_ACTIVE)', async () => {
		const deps = makeDeps({
			checkMqtt: vi.fn(async () => ({ ok: false as const, reason: 'AUTH' as const }))
		});
		const result = await runBambuPreflight(INPUT, deps, 'A1');
		expect(result).toMatchObject({ ok: false, error: 'WRONG_ACCESS_CODE' });
		expect(deps.checkTutkDisabled).not.toHaveBeenCalled();
	});

	it('unknown model falls back to H2C path (runs RTSPS, not TLS:6000)', async () => {
		const deps = makeDeps();
		const result = await runBambuPreflight(INPUT, deps, 'BOGUS_MODEL');
		expect(result).toEqual({ ok: true });
		expect(deps.checkRtsps).toHaveBeenCalledTimes(1);
		expect(deps.checkTls6000).not.toHaveBeenCalled();
		expect(deps.checkTutkDisabled).not.toHaveBeenCalled();
	});
});
