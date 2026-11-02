import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// We need to mock the db module and crypto module for settings tests
import { vi } from 'vitest';

const TEST_DB_PATH = resolve('data/test-settings.db');
let testSqlite: InstanceType<typeof Database>;
let testDb: ReturnType<typeof drizzle>;

// Setup test database before mocking
beforeAll(() => {
	mkdirSync(resolve('data'), { recursive: true });
	testSqlite = new Database(TEST_DB_PATH);
	testSqlite.pragma('journal_mode = WAL');
	testDb = drizzle(testSqlite, { schema });

	// Create tables
	testSqlite.exec(`
		CREATE TABLE IF NOT EXISTS settings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL UNIQUE,
			value TEXT NOT NULL,
			encrypted INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
});

afterAll(() => {
	testSqlite.close();
	if (existsSync(TEST_DB_PATH)) {
		unlinkSync(TEST_DB_PATH);
	}
});

// Mock the db client module to use our test database
vi.mock('$lib/server/db/client', () => ({
	get db() {
		return testDb;
	}
}));

// Mock $env/dynamic/private for crypto
vi.mock('$env/dynamic/private', () => ({
	env: {
		DB_ENCRYPTION_KEY: 'a'.repeat(32)
	}
}));

import { getSetting, getSettings, saveSetting, saveSettings } from './settings';

describe('settings service', () => {
	beforeEach(() => {
		// Clear settings table before each test
		testSqlite.exec('DELETE FROM settings');
	});

	it('saveSetting stores value, getSetting retrieves it', async () => {
		await saveSetting('proxmox_host', '192.0.2.16');
		const value = await getSetting('proxmox_host');
		expect(value).toBe('192.0.2.16');
	});

	it('saveSetting encrypts sensitive keys (proxmox_token_secret)', async () => {
		await saveSetting('proxmox_token_secret', 'uuid-here');

		// Read raw value from DB to verify it's encrypted
		const row = testSqlite
			.prepare('SELECT value, encrypted FROM settings WHERE key = ?')
			.get('proxmox_token_secret') as { value: string; encrypted: number } | undefined;

		expect(row).toBeDefined();
		expect(row!.encrypted).toBe(1);
		// The raw value should NOT be the plaintext
		expect(row!.value).not.toBe('uuid-here');
		// But getSetting should decrypt it
		const decrypted = await getSetting('proxmox_token_secret');
		expect(decrypted).toBe('uuid-here');
	});

	it('getSettings with prefix returns all matching settings', async () => {
		await saveSetting('proxmox_host', '192.0.2.16');
		await saveSetting('proxmox_token_id', 'root@pam!mytoken');
		await saveSetting('unifi_host', '192.0.2.1');

		const proxmoxSettings = await getSettings('proxmox_');
		expect(Object.keys(proxmoxSettings)).toHaveLength(2);
		expect(proxmoxSettings['proxmox_host']).toBe('192.0.2.16');
		expect(proxmoxSettings['proxmox_token_id']).toBe('root@pam!mytoken');
	});

	it('saveSettings saves multiple settings at once', async () => {
		await saveSettings({
			proxmox_host: '10.0.0.1',
			proxmox_token_id: 'admin@pve!token'
		});

		const host = await getSetting('proxmox_host');
		const tokenId = await getSetting('proxmox_token_id');
		expect(host).toBe('10.0.0.1');
		expect(tokenId).toBe('admin@pve!token');
	});

	it('saveSetting upserts on duplicate key', async () => {
		await saveSetting('proxmox_host', 'old-value');
		await saveSetting('proxmox_host', 'new-value');
		const value = await getSetting('proxmox_host');
		expect(value).toBe('new-value');
	});

	it('getSetting returns null for non-existent key', async () => {
		const value = await getSetting('nonexistent');
		expect(value).toBeNull();
	});

	it('saving UniFi settings works (INFRA-03)', async () => {
		await saveSetting('unifi_host', '192.0.2.1');
		const value = await getSetting('unifi_host');
		expect(value).toBe('192.0.2.1');
	});

	it('unifi_password is encrypted as a sensitive key', async () => {
		await saveSetting('unifi_password', 'secret123');
		const row = testSqlite
			.prepare('SELECT encrypted FROM settings WHERE key = ?')
			.get('unifi_password') as { encrypted: number } | undefined;
		expect(row!.encrypted).toBe(1);

		const decrypted = await getSetting('unifi_password');
		expect(decrypted).toBe('secret123');
	});
});
