import { describe, it, expect, vi } from 'vitest';

// Mock $env/dynamic/private before any imports that transitively load env config.
vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// Mock the schema and db client so importing bambu-mqtt.ts does not trigger
// SQLite side effects (ensureColumn against a missing `cameras` table).
vi.mock('$lib/server/db/schema', () => ({
	cameras: { id: 'id', cameraType: 'cameraType' }
}));

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					get: () => null,
					all: () => []
				})
			})
		})
	},
	sqlite: {},
	DB_ABS_PATH: ''
}));

// Mock ssh + crypto — bambu-mqtt.ts imports them at module load.
vi.mock('./ssh', () => ({
	connectToProxmox: vi.fn(),
	executeOnContainer: vi.fn()
}));

vi.mock('./crypto', () => ({
	decrypt: vi.fn((s: string) => s)
}));

// Imports must come after the mocks above.
import { handleMqttMessage, type SubscriberLike } from './bambu-mqtt';

// Minimal subscriber fixture: the TUTK watch only touches `lastError` and
// `lastMessageAt`. Payloads intentionally avoid `gcode_state` so the
// adaptive-mode state machine (which needs the DB) is not invoked.
function makeSub(overrides: Partial<SubscriberLike> = {}): SubscriberLike {
	return {
		cameraId: 1,
		model: 'A1',
		lastError: null,
		lastMessageAt: 0,
		...overrides
	};
}

function asPayload(obj: unknown): Buffer {
	return Buffer.from(JSON.stringify(obj));
}

describe('MQTT message handler — TUTK runtime watch (Phase 18 / BAMBU-A1-06 / D-06)', () => {
	it('sets A1_CLOUD_MODE_ACTIVE when tutk_server transitions to enable', () => {
		const sub = makeSub({ lastError: null });
		handleMqttMessage(sub, asPayload({ print: { ipcam: { tutk_server: 'enable' } } }));
		expect(sub.lastError).toBe('A1_CLOUD_MODE_ACTIVE');
	});

	it('clears A1_CLOUD_MODE_ACTIVE when tutk_server transitions to disable', () => {
		const sub = makeSub({ lastError: 'A1_CLOUD_MODE_ACTIVE' });
		handleMqttMessage(sub, asPayload({ print: { ipcam: { tutk_server: 'disable' } } }));
		expect(sub.lastError).toBeNull();
	});

	it('preserves A1_CLOUD_MODE_ACTIVE across messages that do NOT carry tutk_server', () => {
		const sub = makeSub({ lastError: 'A1_CLOUD_MODE_ACTIVE' });
		// Delta message without ipcam.tutk_server — only unrelated fields present.
		handleMqttMessage(sub, asPayload({ print: { mc_percent: 42 } }));
		expect(sub.lastError).toBe('A1_CLOUD_MODE_ACTIVE');
	});

	it('preserves A1_CLOUD_MODE_ACTIVE when ipcam delta lacks tutk_server field', () => {
		const sub = makeSub({ lastError: 'A1_CLOUD_MODE_ACTIVE' });
		// ipcam block present but without tutk_server — undefined is not a transition.
		handleMqttMessage(sub, asPayload({ print: { ipcam: { ipcam_record: 'enable' } } }));
		expect(sub.lastError).toBe('A1_CLOUD_MODE_ACTIVE');
	});

	it('clears transient connection errors on any message (existing behaviour preserved)', () => {
		const sub = makeSub({ lastError: 'WRONG_ACCESS_CODE' });
		handleMqttMessage(sub, asPayload({ print: { mc_percent: 0 } }));
		expect(sub.lastError).toBeNull();
	});

	it('does not log re-fire when already in A1_CLOUD_MODE_ACTIVE (edge-trigger)', () => {
		const sub = makeSub({ lastError: 'A1_CLOUD_MODE_ACTIVE' });
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		handleMqttMessage(sub, asPayload({ print: { ipcam: { tutk_server: 'enable' } } }));
		expect(logSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it('does not alter lastError when payload is malformed JSON', () => {
		const sub = makeSub({ lastError: 'A1_CLOUD_MODE_ACTIVE' });
		handleMqttMessage(sub, Buffer.from('not-valid-json{'));
		// Current A1 flag must survive — parse error is a silent no-op by contract.
		expect(sub.lastError).toBe('A1_CLOUD_MODE_ACTIVE');
	});

	it('updates lastMessageAt on every message (liveness tracking)', () => {
		const sub = makeSub({ lastMessageAt: 0 });
		const before = Date.now();
		handleMqttMessage(sub, asPayload({ print: {} }));
		expect(sub.lastMessageAt).toBeGreaterThanOrEqual(before);
	});

	it('first-seen-as-enable (lastError === null) still transitions to A1_CLOUD_MODE_ACTIVE', () => {
		// Edge-trigger semantics: the initial observation of enable (no prior disable seen)
		// must still set the flag. This covers the "first-seen-as-enable" case.
		const sub = makeSub({ lastError: null });
		handleMqttMessage(sub, asPayload({ print: { ipcam: { tutk_server: 'enable' } } }));
		expect(sub.lastError).toBe('A1_CLOUD_MODE_ACTIVE');
	});

	it('H2C does NOT get A1_CLOUD_MODE_ACTIVE — the flag is A1-only', () => {
		// H2C reports tutk_server in its MQTT deltas too, but its camera runs on
		// RTSPS:322 and is unaffected by TUTK cloud routing. Firing the A1 flag
		// on H2C would be a UI false-positive — the status card would show an
		// error even though the stream is fine. Gate is `sub.model === 'A1'`.
		const sub = makeSub({ model: 'H2C', lastError: null });
		handleMqttMessage(sub, asPayload({ print: { ipcam: { tutk_server: 'enable' } } }));
		expect(sub.lastError).toBeNull();
	});

	it('disable branch does not clobber non-A1 error (WRONG_ACCESS_CODE auto-clears via conditional reset)', () => {
		// The conditional reset at the top of the handler clears non-A1 errors on any
		// message arrival. The disable branch itself is guarded (only fires when current
		// is A1_CLOUD_MODE_ACTIVE), so WRONG_ACCESS_CODE ends up null via the reset path.
		const sub = makeSub({ lastError: 'WRONG_ACCESS_CODE' });
		handleMqttMessage(sub, asPayload({ print: { ipcam: { tutk_server: 'disable' } } }));
		expect(sub.lastError).toBeNull();
	});
});
