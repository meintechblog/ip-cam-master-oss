// v1.3 Phase 19 Plan 03 — RED tests for orchestration/protect-hub/catalog.ts.
// Uses an in-memory better-sqlite3 + Drizzle to exercise the real upsert
// transaction without touching the on-disk dev DB.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// Hoisted state — the catalog module imports `fetchBootstrap` from
// protect-bridge.ts; we substitute a mock so we never make a real
// UDM call. Hoisting is necessary because vi.mock factories can't
// close over module-scope vars.
const { mockFetchBootstrap, memDbRef } = vi.hoisted(() => ({
	mockFetchBootstrap: vi.fn(),
	memDbRef: {
		db: null as ReturnType<typeof drizzle> | null,
		sqlite: null as Database.Database | null
	}
}));

vi.mock('$lib/server/services/protect-bridge', async () => {
	const actual = await vi.importActual<typeof import('../../services/protect-bridge')>(
		'$lib/server/services/protect-bridge'
	);
	return { ...actual, fetchBootstrap: mockFetchBootstrap };
});

// catalog.ts now resolves the Protect controller host via getSettings('unifi_')
// so it can build correct rtsp:// URLs (instead of cam.host which UVC cams don't
// self-host on :7441). Stub returns a fixed test controller.
vi.mock('$lib/server/services/settings', () => ({
	getSettings: vi.fn().mockResolvedValue({ unifi_host: '192.0.2.1' })
}));

vi.mock('$lib/server/db/client', () => ({
	get db() {
		return memDbRef.db;
	},
	get sqlite() {
		return memDbRef.sqlite;
	},
	DB_ABS_PATH: ':memory:'
}));

import * as schema from '../../db/schema';
import firstPartyFixture from '../../services/__fixtures__/protect-bootstrap-first-party-3-channel.json' with {
	type: 'json'
};
import singleChannelFixture from '../../services/__fixtures__/protect-bootstrap-third-party-1-channel.json' with {
	type: 'json'
};

import { discover, loadCatalog } from './catalog';

// Mirror the production schema — same DDL the boot path applies in
// src/lib/server/db/client.ts. If that file changes, this CREATE block
// must mirror.
function freshDb() {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');

	sqlite.exec(`
		CREATE TABLE cameras (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			vmid INTEGER NOT NULL,
			name TEXT NOT NULL,
			ip TEXT NOT NULL,
			username TEXT NOT NULL,
			password TEXT NOT NULL,
			camera_type TEXT NOT NULL DEFAULT 'mobotix',
			stream_path TEXT NOT NULL DEFAULT '/stream0/mobotix.mjpeg',
			width INTEGER NOT NULL DEFAULT 1280,
			height INTEGER NOT NULL DEFAULT 720,
			fps INTEGER NOT NULL DEFAULT 20,
			bitrate INTEGER NOT NULL DEFAULT 2000,
			stream_name TEXT NOT NULL,
			rtsp_url TEXT,
			container_ip TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			access_code TEXT,
			serial_number TEXT,
			model TEXT,
			print_state TEXT,
			stream_mode TEXT DEFAULT 'adaptive',
			rtsp_auth_enabled INTEGER NOT NULL DEFAULT 0,
			source TEXT NOT NULL DEFAULT 'managed',
			mac TEXT,
			external_id TEXT,
			hub_bridge_id INTEGER,
			manufacturer TEXT,
			model_name TEXT,
			kind TEXT NOT NULL DEFAULT 'unknown',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	sqlite.exec(`
		CREATE TABLE protect_stream_catalog (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			camera_id INTEGER NOT NULL,
			quality TEXT NOT NULL,
			codec TEXT,
			width INTEGER,
			height INTEGER,
			fps INTEGER,
			bitrate INTEGER,
			rtsp_url TEXT,
			share_enabled INTEGER NOT NULL DEFAULT 0,
			cached_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	sqlite.exec(`
		CREATE TABLE protect_hub_bridges (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			vmid INTEGER NOT NULL UNIQUE,
			hostname TEXT NOT NULL,
			container_ip TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			last_deployed_yaml_hash TEXT,
			last_reconciled_at TEXT,
			last_health_check_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	sqlite.exec(`
		CREATE TABLE camera_outputs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			camera_id INTEGER NOT NULL,
			output_type TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			config TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	sqlite.exec(`
		CREATE INDEX idx_protect_stream_catalog_cam ON protect_stream_catalog(camera_id)
	`);
	sqlite.exec(`CREATE INDEX idx_camera_outputs_cam ON camera_outputs(camera_id)`);

	memDbRef.sqlite = sqlite;
	memDbRef.db = drizzle(sqlite, { schema });
}

// Filter out non-camera rows (e.g. NVR) — fetchBootstrap normally does this,
// but the mocked version returns whatever we hand it, so we mirror the filter
// in test setup.
const onlyCameras = <T extends { modelKey: string }>(rows: T[]): T[] =>
	rows.filter((r) => r.modelKey === 'camera');

beforeEach(() => {
	freshDb();
	mockFetchBootstrap.mockReset();
});

describe('discover() — first-party 3-channel happy path', () => {
	it('inserts cam + 3 catalog rows with correct enrichment', async () => {
		mockFetchBootstrap.mockResolvedValueOnce({
			ok: true,
			cameras: onlyCameras(firstPartyFixture as never[])
		});

		const result = await discover();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.insertedCams).toBe(1);
			expect(result.updatedCams).toBe(0);
			expect(result.insertedChannels).toBe(3);
		}

		const camRows = memDbRef.sqlite!
			.prepare(`SELECT * FROM cameras WHERE source = 'external'`)
			.all() as Array<Record<string, unknown>>;
		expect(camRows).toHaveLength(1);
		expect(camRows[0].mac).toBe('aabbcc112233');
		expect(camRows[0].kind).toBe('first-party');
		expect(camRows[0].manufacturer).toBe('Ubiquiti');
		expect(camRows[0].model_name).toBe('G4 Bullet');
		expect(camRows[0].external_id).toBe('uuid-firstparty-3ch');

		const catalogRows = memDbRef.sqlite!
			.prepare(`SELECT quality FROM protect_stream_catalog`)
			.all() as Array<{ quality: string }>;
		expect(catalogRows).toHaveLength(3);
		expect(catalogRows.map((r) => r.quality).sort()).toEqual(['High', 'Low', 'Medium']);
	});
});

describe('discover() — single-channel third-party (HUB-CAT-06)', () => {
	it('produces exactly 1 catalog row, NOT 3 hardcoded slots', async () => {
		mockFetchBootstrap.mockResolvedValueOnce({
			ok: true,
			cameras: onlyCameras(singleChannelFixture as never[])
		});

		await discover();

		const rows = memDbRef.sqlite!
			.prepare(`SELECT * FROM protect_stream_catalog`)
			.all() as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0].quality).toBe('Default');

		const cam = memDbRef.sqlite!
			.prepare(`SELECT * FROM cameras WHERE source = 'external'`)
			.get() as Record<string, unknown>;
		expect(cam.kind).toBe('third-party');
		expect(cam.manufacturer).toBe('Mobotix');
		expect(cam.model_name).toBe('Mobotix S15');
		// Normalised: '11-22-33-aa-bb-cc' → '112233aabbcc'
		expect(cam.mac).toBe('112233aabbcc');
	});
});

describe('discover() — idempotency', () => {
	it('second call with same fixture is a no-op net change', async () => {
		mockFetchBootstrap.mockResolvedValue({
			ok: true,
			cameras: onlyCameras(firstPartyFixture as never[])
		});

		await discover();
		const camCountBefore = (
			memDbRef.sqlite!.prepare(`SELECT COUNT(*) AS c FROM cameras`).get() as { c: number }
		).c;
		const catalogCountBefore = (
			memDbRef.sqlite!
				.prepare(`SELECT COUNT(*) AS c FROM protect_stream_catalog`)
				.get() as { c: number }
		).c;

		const result2 = await discover();
		expect(result2.ok).toBe(true);
		if (result2.ok) {
			expect(result2.insertedCams).toBe(0);
			expect(result2.updatedCams).toBe(1);
		}

		const camCountAfter = (
			memDbRef.sqlite!.prepare(`SELECT COUNT(*) AS c FROM cameras`).get() as { c: number }
		).c;
		const catalogCountAfter = (
			memDbRef.sqlite!
				.prepare(`SELECT COUNT(*) AS c FROM protect_stream_catalog`)
				.get() as { c: number }
		).c;

		expect(camCountAfter).toBe(camCountBefore);
		expect(catalogCountAfter).toBe(catalogCountBefore);
	});
});

describe('discover() — UDM unreachable', () => {
	it('returns reason controller_unreachable and does NOT modify DB', async () => {
		mockFetchBootstrap.mockResolvedValueOnce({
			ok: false,
			reason: 'controller_unreachable',
			error: new Error('connect ECONNREFUSED 192.0.2.1:443')
		});

		const result = await discover();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('controller_unreachable');

		const camCount = (
			memDbRef.sqlite!
				.prepare(`SELECT COUNT(*) AS c FROM cameras WHERE source = 'external'`)
				.get() as { c: number }
		).c;
		expect(camCount).toBe(0);
	});
});

describe('discover() — MAC NOT NULL invariant (L-1 enforcement)', () => {
	it('rolls back the whole transaction when normalised mac is empty', async () => {
		const cam = onlyCameras(firstPartyFixture as never[])[0] as Record<string, unknown>;
		const bad = [{ ...cam, mac: ':-:-' }];
		mockFetchBootstrap.mockResolvedValueOnce({ ok: true, cameras: bad as never[] });

		const result = await discover();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('unknown');
			expect(result.error.message.toLowerCase()).toContain('mac');
		}

		const camCount = (
			memDbRef.sqlite!
				.prepare(`SELECT COUNT(*) AS c FROM cameras WHERE source = 'external'`)
				.get() as { c: number }
		).c;
		expect(camCount).toBe(0);

		const catalogCount = (
			memDbRef.sqlite!
				.prepare(`SELECT COUNT(*) AS c FROM protect_stream_catalog`)
				.get() as { c: number }
		).c;
		expect(catalogCount).toBe(0);
	});
});

describe('discover() — disabled channels skipped', () => {
	it('does not insert catalog rows for channels where enabled=false', async () => {
		const camRow = onlyCameras(firstPartyFixture as never[])[0] as {
			channels: Array<{ enabled: boolean }>;
		};
		const fixture = [
			{
				...camRow,
				channels: camRow.channels.map((ch, i) => (i === 0 ? { ...ch, enabled: false } : ch))
			}
		];
		mockFetchBootstrap.mockResolvedValueOnce({ ok: true, cameras: fixture as never[] });

		await discover();

		const count = (
			memDbRef.sqlite!
				.prepare(`SELECT COUNT(*) AS c FROM protect_stream_catalog`)
				.get() as { c: number }
		).c;
		expect(count).toBe(2); // 3 channels minus 1 disabled
	});
});

describe('discover() — rename updates row by MAC, preserves cameras.id', () => {
	it('keeps the same primary key when name changes', async () => {
		const orig = onlyCameras(firstPartyFixture as never[]);
		mockFetchBootstrap.mockResolvedValueOnce({ ok: true, cameras: orig });
		await discover();
		const idBefore = (
			memDbRef.sqlite!
				.prepare(`SELECT id FROM cameras WHERE source = 'external'`)
				.get() as { id: number }
		).id;

		const renamed = orig.map((c) => ({
			...(c as { name: string }),
			name: (c as { name: string }).name + ' (renamed)'
		}));
		mockFetchBootstrap.mockResolvedValueOnce({ ok: true, cameras: renamed as never[] });
		await discover();

		const after = memDbRef.sqlite!
			.prepare(`SELECT id, name FROM cameras WHERE source = 'external'`)
			.get() as { id: number; name: string };
		expect(after.id).toBe(idBefore);
		expect(after.name).toMatch(/renamed/);
	});
});

describe('loadCatalog()', () => {
	it('returns cached state without calling fetchBootstrap', async () => {
		mockFetchBootstrap.mockResolvedValueOnce({
			ok: true,
			cameras: onlyCameras(firstPartyFixture as never[])
		});
		await discover();
		mockFetchBootstrap.mockClear();

		const cached = await loadCatalog();
		expect(mockFetchBootstrap).not.toHaveBeenCalled();
		expect(cached.cams).toHaveLength(1);
		const camId = cached.cams[0].id;
		expect(cached.catalogByCamId[camId]).toHaveLength(3);
		expect(typeof cached.lastDiscoveredAt).toBe('number');
	});
});
