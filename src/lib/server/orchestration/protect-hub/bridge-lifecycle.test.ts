// v1.3 Phase 20 — Tests for bridge-lifecycle.ts.
// Uses in-memory better-sqlite3 + Drizzle. Proxmox service is mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

const { memDbRef, mockStartContainer, mockStopContainer } = vi.hoisted(() => ({
	memDbRef: {
		db: null as ReturnType<typeof drizzle> | null,
		sqlite: null as Database.Database | null
	},
	mockStartContainer: vi.fn(),
	mockStopContainer: vi.fn()
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

vi.mock('$lib/server/services/proxmox', () => ({
	startContainer: mockStartContainer,
	stopContainer: mockStopContainer
}));

import * as schema from '../../db/schema';
import { getBridgeStatus, startBridge, stopBridge, restartBridge } from './bridge-lifecycle';

function freshDb() {
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
		)
	`);

	memDbRef.sqlite = sqlite;
	memDbRef.db = drizzle(sqlite, { schema });
}

function insertBridge(status: string, vmid = 1000) {
	memDbRef.sqlite!.exec(`
		INSERT INTO protect_hub_bridges (vmid, hostname, container_ip, status, created_at, updated_at)
		VALUES (${vmid}, 'protect-hub', '192.0.2.100', '${status}', datetime('now'), datetime('now'))
	`);
}

beforeEach(() => {
	freshDb();
	mockStartContainer.mockReset().mockResolvedValue(undefined);
	mockStopContainer.mockReset().mockResolvedValue(undefined);
});

describe('getBridgeStatus()', () => {
	it('returns null when no bridge exists', () => {
		const result = getBridgeStatus();
		expect(result).toBeNull();
	});

	it('returns the bridge row when it exists', () => {
		insertBridge('running');
		const result = getBridgeStatus();
		expect(result).not.toBeNull();
		expect(result!.vmid).toBe(1000);
		expect(result!.status).toBe('running');
	});
});

describe('startBridge()', () => {
	it('returns error when no bridge exists', async () => {
		const result = await startBridge();
		expect(result.ok).toBe(false);
		expect(result.error).toBe('No bridge exists');
	});

	it('is no-op when already running', async () => {
		insertBridge('running');
		const result = await startBridge();
		expect(result.ok).toBe(true);
		expect(mockStartContainer).not.toHaveBeenCalled();
	});

	it('starts stopped bridge and updates status', async () => {
		insertBridge('stopped');
		const result = await startBridge();
		expect(result.ok).toBe(true);
		expect(mockStartContainer).toHaveBeenCalledWith(1000);

		const row = memDbRef.sqlite!
			.prepare('SELECT status FROM protect_hub_bridges')
			.get() as { status: string };
		expect(row.status).toBe('running');
	});

	it('sets status=failed on error', async () => {
		insertBridge('stopped');
		mockStartContainer.mockRejectedValue(new Error('API error'));

		const result = await startBridge();
		expect(result.ok).toBe(false);
		expect(result.error).toContain('API error');

		const row = memDbRef.sqlite!
			.prepare('SELECT status FROM protect_hub_bridges')
			.get() as { status: string };
		expect(row.status).toBe('failed');
	});
});

describe('stopBridge()', () => {
	it('returns error when no bridge exists', async () => {
		const result = await stopBridge();
		expect(result.ok).toBe(false);
	});

	it('is no-op when already stopped', async () => {
		insertBridge('stopped');
		const result = await stopBridge();
		expect(result.ok).toBe(true);
		expect(mockStopContainer).not.toHaveBeenCalled();
	});

	it('stops running bridge and updates status to stopped', async () => {
		insertBridge('running');
		const result = await stopBridge();
		expect(result.ok).toBe(true);
		expect(mockStopContainer).toHaveBeenCalledWith(1000);

		const row = memDbRef.sqlite!
			.prepare('SELECT status FROM protect_hub_bridges')
			.get() as { status: string };
		expect(row.status).toBe('stopped');
	});
});

describe('restartBridge()', () => {
	it('returns error when no bridge exists', async () => {
		const result = await restartBridge();
		expect(result.ok).toBe(false);
	});

	it('calls stop then start and updates status to running', async () => {
		insertBridge('running');
		const callOrder: string[] = [];
		mockStopContainer.mockImplementation(async () => {
			callOrder.push('stop');
		});
		mockStartContainer.mockImplementation(async () => {
			callOrder.push('start');
		});

		const result = await restartBridge();
		expect(result.ok).toBe(true);
		expect(callOrder).toEqual(['stop', 'start']);

		const row = memDbRef.sqlite!
			.prepare('SELECT status FROM protect_hub_bridges')
			.get() as { status: string };
		expect(row.status).toBe('running');
	});

	it('sets status=failed on restart error', async () => {
		insertBridge('running');
		mockStopContainer.mockResolvedValue(undefined);
		mockStartContainer.mockRejectedValue(new Error('start failed'));

		const result = await restartBridge();
		expect(result.ok).toBe(false);

		const row = memDbRef.sqlite!
			.prepare('SELECT status FROM protect_hub_bridges')
			.get() as { status: string };
		expect(row.status).toBe('failed');
	});
});
