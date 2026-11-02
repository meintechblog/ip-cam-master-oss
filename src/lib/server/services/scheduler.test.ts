// v1.3 Phase 21 Plan 06 — scheduler.ts protect-hub interval + 2-strike health probe.
//
// Replaces the Wave-0 stub from Plan 01. Covers:
//   - HUB-RCN-01: 5-min tick fires reconcile when settings.protect_hub_enabled='true'
//   - HUB-RCN-01: silent when disabled OR when no running bridge present
//   - HUB-OPS-05: 2-strike threshold (1st failure does NOT flip status; 2nd does)
//   - HUB-OPS-05: recovery (single success after 'unhealthy' → 'running')
//   - lifecycle: stopScheduler clears the protect-hub interval (no leaks)
//
// In-memory better-sqlite3 + Drizzle for the small slice of schema the tick
// touches (protect_hub_bridges, settings). vi.useFakeTimers() to step the
// 5-min cadence. vi.resetModules() in beforeEach so module-scoped state
// (`bridgeFailureCount`, the interval handles) does NOT leak across tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

const {
	memDbRef,
	mockGetSetting,
	mockGetSettings,
	mockReconcile,
	mockStartWs,
	mockStopWs,
	mockStartBambuSubscribers,
	mockStopBambuSubscribers,
	mockStoreHealthEvent,
	mockStoreEvents,
	mockCleanupOldEvents,
	mockCleanupExpiredSessions,
	mockGetProtectStatus,
	mockScanUdmLogs,
	mockCleanupOldUpdateLogs
} = vi.hoisted(() => ({
	memDbRef: {
		db: null as ReturnType<typeof drizzle> | null,
		sqlite: null as Database.Database | null
	},
	mockGetSetting: vi.fn<(key: string) => Promise<string | null>>(),
	mockGetSettings: vi.fn<(prefix: string) => Promise<Record<string, string>>>(),
	mockReconcile: vi.fn(),
	mockStartWs: vi.fn(),
	mockStopWs: vi.fn(),
	mockStartBambuSubscribers: vi.fn(() => Promise.resolve()),
	mockStopBambuSubscribers: vi.fn(),
	mockStoreHealthEvent: vi.fn(),
	mockStoreEvents: vi.fn(),
	mockCleanupOldEvents: vi.fn(),
	mockCleanupExpiredSessions: vi.fn(),
	mockGetProtectStatus: vi.fn(() => Promise.resolve(null)),
	mockScanUdmLogs: vi.fn(() => Promise.resolve([])),
	mockCleanupOldUpdateLogs: vi.fn(() =>
		Promise.resolve({ entriesDropped: 0, filesRemoved: 0 })
	)
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

vi.mock('./settings', () => ({
	getSetting: mockGetSetting,
	getSettings: mockGetSettings
}));

vi.mock('./events', () => ({
	storeEvents: mockStoreEvents,
	cleanupOldEvents: mockCleanupOldEvents,
	storeHealthEvent: mockStoreHealthEvent,
	storeEvent: vi.fn()
}));

vi.mock('./udm-logs', () => ({
	scanUdmLogs: mockScanUdmLogs
}));

vi.mock('./auth', () => ({
	cleanupExpiredSessions: mockCleanupExpiredSessions
}));

vi.mock('./protect', () => ({
	getProtectStatus: mockGetProtectStatus
}));

vi.mock('./update-history', () => ({
	cleanupOldUpdateLogs: mockCleanupOldUpdateLogs
}));

vi.mock('./bambu-mqtt', () => ({
	startBambuSubscribers: mockStartBambuSubscribers,
	stopBambuSubscribers: mockStopBambuSubscribers
}));

// Dynamic-import targets in scheduler.ts. The tick + boot path call these
// via `await import('$lib/server/orchestration/protect-hub/reconcile')` etc.
vi.mock('$lib/server/orchestration/protect-hub/reconcile', () => ({
	reconcile: mockReconcile,
	isReconcilerBusy: vi.fn(() => false)
}));

vi.mock('$lib/server/orchestration/protect-hub/ws-manager', () => ({
	startWs: mockStartWs,
	stopWs: mockStopWs
}));

import * as schema from '../db/schema';

function freshDb(): void {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
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
		);
		CREATE TABLE protect_hub_reconcile_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			reconcile_id TEXT NOT NULL,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			completed_at TEXT,
			status TEXT NOT NULL DEFAULT 'running',
			hash_changed INTEGER NOT NULL DEFAULT 0,
			deployed_yaml_hash TEXT,
			error TEXT
		);
		CREATE TABLE settings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL UNIQUE,
			value TEXT NOT NULL,
			encrypted INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		-- Mirrors the production cameras table just enough for db.select().from(cameras).all()
		-- to succeed. Drizzle reads every column declared in schema.cameras even when no
		-- rows exist, so every NOT-NULL column the production schema declares must exist
		-- here too (otherwise the .all() preparation throws "no such column: vmid" etc.).
		CREATE TABLE cameras (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			vmid INTEGER NOT NULL DEFAULT 0,
			name TEXT NOT NULL DEFAULT '',
			ip TEXT NOT NULL DEFAULT '',
			username TEXT NOT NULL DEFAULT '',
			password TEXT NOT NULL DEFAULT '',
			camera_type TEXT NOT NULL DEFAULT 'mobotix',
			stream_path TEXT NOT NULL DEFAULT '/stream0/mobotix.mjpeg',
			width INTEGER NOT NULL DEFAULT 1280,
			height INTEGER NOT NULL DEFAULT 720,
			fps INTEGER NOT NULL DEFAULT 20,
			bitrate INTEGER NOT NULL DEFAULT 2000,
			stream_name TEXT NOT NULL DEFAULT '',
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
		);
	`);
	memDbRef.sqlite = sqlite;
	memDbRef.db = drizzle(sqlite, { schema });
}

function seedRunningBridge(): void {
	memDbRef.sqlite!.exec(
		`INSERT INTO protect_hub_bridges (vmid, hostname, container_ip, status)
		 VALUES (2014, 'protect-hub-bridge', '192.0.2.139', 'running')`
	);
}

function seedUnhealthyBridge(): void {
	memDbRef.sqlite!.exec(
		`INSERT INTO protect_hub_bridges (vmid, hostname, container_ip, status)
		 VALUES (2014, 'protect-hub-bridge', '192.0.2.139', 'unhealthy')`
	);
}

function getBridgeStatus(): string | undefined {
	return (
		memDbRef.sqlite!.prepare('SELECT status FROM protect_hub_bridges WHERE id = 1').get() as
			| { status: string }
			| undefined
	)?.status;
}

describe('scheduler — protect hub reconcile tick (HUB-RCN-01)', () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-06T13:00:00Z'));
		freshDb();
		mockGetSetting.mockReset();
		mockGetSettings.mockReset();
		mockGetSettings.mockResolvedValue({}); // unifi_host absent → log-scan no-ops
		mockReconcile.mockReset();
		mockReconcile.mockResolvedValue({
			ok: true,
			status: 'no_op',
			reconcileId: 'mock',
			hashChanged: false,
			outputCount: 0
		});
		mockStartWs.mockReset();
		mockStartWs.mockResolvedValue(undefined);
		mockStopWs.mockReset();
		mockStartBambuSubscribers.mockReset();
		mockStartBambuSubscribers.mockResolvedValue(undefined);
		mockStoreHealthEvent.mockReset();
		mockStoreEvents.mockReset();
		mockCleanupOldEvents.mockReset();
		mockCleanupExpiredSessions.mockReset();
		mockGetProtectStatus.mockReset();
		mockGetProtectStatus.mockResolvedValue(null);
		mockScanUdmLogs.mockReset();
		mockScanUdmLogs.mockResolvedValue([]);
		mockCleanupOldUpdateLogs.mockReset();
		mockCleanupOldUpdateLogs.mockResolvedValue({ entriesDropped: 0, filesRemoved: 0 });
	});

	afterEach(async () => {
		// Best-effort stop so per-test interval handles do not leak across runs.
		try {
			const mod = await import('./scheduler');
			mod.stopScheduler();
		} catch {
			/* ignore */
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('5-min tick — fires reconcile when settings.protect_hub_enabled=true AND a running bridge exists', async () => {
		seedRunningBridge();
		mockGetSetting.mockImplementation(async (key: string) => {
			if (key === 'protect_hub_enabled') return 'true';
			return null;
		});

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		// startWs is fired-and-forgotten via void-IIFE during startScheduler;
		// flush microtasks so its dynamic import resolves before assertions.
		await vi.advanceTimersByTimeAsync(0);

		// Before 5min, the reconcile tick has not fired.
		expect(mockReconcile).not.toHaveBeenCalled();

		// Advance past the first 5min tick + flush async chain.
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mockReconcile).toHaveBeenCalledTimes(1);
		expect(mockReconcile).toHaveBeenCalledWith(1, 'tick');
	});

	it('5-min tick — silent when settings.protect_hub_enabled=false', async () => {
		seedRunningBridge();
		mockGetSetting.mockImplementation(async (key: string) => {
			if (key === 'protect_hub_enabled') return 'false';
			return null;
		});

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await vi.advanceTimersByTimeAsync(5 * 60_000); // second tick — still silent

		expect(mockReconcile).not.toHaveBeenCalled();
	});

	it('5-min tick — silent when settings.protect_hub_enabled is missing (null)', async () => {
		seedRunningBridge();
		mockGetSetting.mockResolvedValue(null);

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mockReconcile).not.toHaveBeenCalled();
	});

	it('5-min tick — silent when no running bridge (status=pending)', async () => {
		// Insert a bridge in pending state; should NOT match the running query.
		memDbRef.sqlite!.exec(
			`INSERT INTO protect_hub_bridges (vmid, hostname, container_ip, status)
			 VALUES (2014, 'protect-hub-bridge', '192.0.2.139', 'pending')`
		);
		mockGetSetting.mockImplementation(async (key: string) => {
			if (key === 'protect_hub_enabled') return 'true';
			return null;
		});

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mockReconcile).not.toHaveBeenCalled();
	});

	it('startScheduler — boots ws-manager when protect_hub_enabled=true', async () => {
		seedRunningBridge();
		mockGetSetting.mockImplementation(async (key: string) => {
			if (key === 'protect_hub_enabled') return 'true';
			return null;
		});

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		// startWs is dispatched via void-IIFE; flush microtasks so its
		// dynamic import + invocation resolve.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		expect(mockStartWs).toHaveBeenCalledTimes(1);
	});

	it('startScheduler — does NOT boot ws-manager when protect_hub_enabled=false', async () => {
		seedRunningBridge();
		mockGetSetting.mockImplementation(async (key: string) => {
			if (key === 'protect_hub_enabled') return 'false';
			return null;
		});

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		expect(mockStartWs).not.toHaveBeenCalled();
	});

	it('stopScheduler — clears protectHubReconcileInterval (no further reconcile after stop)', async () => {
		seedRunningBridge();
		mockGetSetting.mockImplementation(async (key: string) => {
			if (key === 'protect_hub_enabled') return 'true';
			return null;
		});

		const { startScheduler, stopScheduler } = await import('./scheduler');
		startScheduler();

		// Fire the 1st tick.
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(mockReconcile).toHaveBeenCalledTimes(1);

		stopScheduler();

		// Drain any in-flight async + advance past the next would-be tick.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mockReconcile).toHaveBeenCalledTimes(1); // still 1 — interval cleared

		// stopWs is fired-and-forgotten via void-IIFE; flush.
		await vi.advanceTimersByTimeAsync(0);
		expect(mockStopWs).toHaveBeenCalled();
	});
});

describe('scheduler — bridge health probe 2-strike threshold (HUB-OPS-05)', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-06T13:00:00Z'));
		freshDb();
		mockGetSetting.mockReset();
		// Disable Hub for these tests so the reconcile tick stays silent and
		// only the health probe behaviour is under test.
		mockGetSetting.mockResolvedValue('false');
		mockGetSettings.mockReset();
		mockGetSettings.mockResolvedValue({});
		mockReconcile.mockReset();
		mockStartWs.mockReset();
		mockStartWs.mockResolvedValue(undefined);
		mockStopWs.mockReset();
		mockStartBambuSubscribers.mockReset();
		mockStartBambuSubscribers.mockResolvedValue(undefined);
		mockStoreHealthEvent.mockReset();
		mockGetProtectStatus.mockReset();
		mockGetProtectStatus.mockResolvedValue(null);
		mockScanUdmLogs.mockReset();
		mockScanUdmLogs.mockResolvedValue([]);
		// Re-spy fetch fresh per test so vi.restoreAllMocks() in afterEach
		// does not leave a dangling spy that no longer intercepts global.fetch.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		fetchSpy = vi.spyOn(global, 'fetch') as any;
	});

	afterEach(async () => {
		try {
			const mod = await import('./scheduler');
			mod.stopScheduler();
		} catch {
			/* ignore */
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('2-strike — 1st bridge fetch failure does NOT flip status, 2nd consecutive flips to unhealthy', async () => {
		seedRunningBridge();
		fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		// Tick 1 — 1st failure, status MUST remain 'running'
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		// Drain pending microtasks once more so the AbortController's inner
		// setTimeout(3000) and the resulting catch+DB write resolve.
		await vi.advanceTimersByTimeAsync(0);
		// Sanity: probe was actually exercised against the bridge.
		expect(
			fetchSpy.mock.calls.some((c: unknown[]) =>
				String(c[0]).includes('192.0.2.139:1984')
			)
		).toBe(true);
		expect(getBridgeStatus()).toBe('running');
		expect(
			mockStoreHealthEvent.mock.calls.some((c) =>
				String(c[2]).includes('unreachable 2x')
			)
		).toBe(false);

		// Tick 2 — 2nd consecutive failure, MUST flip to 'unhealthy' + emit event
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(getBridgeStatus()).toBe('unhealthy');
		expect(
			mockStoreHealthEvent.mock.calls.some(
				(c) => String(c[2]).includes('unreachable 2x') && c[3] === 'warning'
			)
		).toBe(true);
	});

	it('recovery — single success on a previously unhealthy bridge flips back to running + emits info event', async () => {
		seedUnhealthyBridge();
		fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

		const { startScheduler } = await import('./scheduler');
		startScheduler();

		// Tick 1 — single success on unhealthy bridge → flip to running.
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(getBridgeStatus()).toBe('running');
		expect(
			mockStoreHealthEvent.mock.calls.some(
				(c) => String(c[2]).includes('go2rtc recovered') && c[3] === 'info'
			)
		).toBe(true);
	});
});
