// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// The real db client needs a pre-created schema on disk; use an in-memory DB instead.
vi.mock('$lib/server/db/client', async () => {
	const { default: Database } = await import('better-sqlite3');
	const sqlite = new Database(':memory:');
	sqlite.exec(
		"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('probe', 'backup-roundtrip');"
	);
	return { sqlite, db: {}, DB_ABS_PATH: ':memory:' };
});

import {
	formatBackupTimestamp,
	validateAndRestore,
	createBackup,
	REQUIRED_TABLES,
	MAX_BACKUP_BYTES
} from './backup';

describe('backup service', () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), 'ipcam-backup-test-'));
	});

	afterEach(() => {
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	describe('formatBackupTimestamp', () => {
		it('formats a typical date into YYYYMMDD-HHMM in local time', () => {
			const d = new Date(2026, 3, 10, 14, 32, 5); // April 10, 2026 14:32:05 local
			expect(formatBackupTimestamp(d)).toBe('20260410-1432');
		});

		it('zero-pads single-digit month/day/hour/minute', () => {
			const d = new Date(2026, 0, 5, 9, 7, 0); // Jan 5, 2026 09:07 local
			expect(formatBackupTimestamp(d)).toBe('20260105-0907');
		});

		it('zero-pads midnight', () => {
			const d = new Date(2026, 11, 31, 0, 0, 0); // Dec 31, 2026 00:00
			expect(formatBackupTimestamp(d)).toBe('20261231-0000');
		});
	});

	describe('REQUIRED_TABLES', () => {
		it('contains the core schema tables', () => {
			for (const t of ['settings', 'containers', 'cameras', 'credentials', 'users', 'events']) {
				expect(REQUIRED_TABLES).toContain(t);
			}
		});
	});

	describe('MAX_BACKUP_BYTES', () => {
		it('is 100 MB', () => {
			expect(MAX_BACKUP_BYTES).toBe(100 * 1024 * 1024);
		});
	});

	function makeValidBackupDb(path: string) {
		const db = new Database(path);
		db.exec(`
			CREATE TABLE settings (id INTEGER PRIMARY KEY, key TEXT, value TEXT);
			CREATE TABLE containers (id INTEGER PRIMARY KEY, vmid INTEGER);
			CREATE TABLE cameras (id INTEGER PRIMARY KEY, name TEXT);
			CREATE TABLE credentials (id INTEGER PRIMARY KEY, name TEXT);
			CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
			CREATE TABLE events (id INTEGER PRIMARY KEY, message TEXT);
		`);
		db.close();
	}

	describe('validateAndRestore', () => {
		it('rejects a file whose name does not end in .db', () => {
			const p = join(scratch, 'upload.bin');
			writeFileSync(p, Buffer.alloc(16));
			const res = validateAndRestore({ uploadedPath: p, originalFilename: 'upload.bin' });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe('invalid_filename');
		});

		it('rejects a file larger than MAX_BACKUP_BYTES', () => {
			const p = join(scratch, 'big.db');
			// Write a sparse-ish file by truncating past MAX_BACKUP_BYTES.
			const fs = require('node:fs') as typeof import('node:fs');
			const fd = fs.openSync(p, 'w');
			try {
				fs.ftruncateSync(fd, MAX_BACKUP_BYTES + 1);
			} finally {
				fs.closeSync(fd);
			}
			expect(statSync(p).size).toBeGreaterThan(MAX_BACKUP_BYTES);
			const res = validateAndRestore({ uploadedPath: p, originalFilename: 'big.db' });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe('file_too_large');
		});

		it('rejects a corrupt file with integrity_check_failed', () => {
			const p = join(scratch, 'corrupt.db');
			writeFileSync(p, Buffer.alloc(4096, 0xab));
			const res = validateAndRestore({ uploadedPath: p, originalFilename: 'corrupt.db' });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe('integrity_check_failed');
		});

		it('rejects a valid SQLite file missing REQUIRED_TABLES', () => {
			const p = join(scratch, 'wrong-schema.db');
			const db = new Database(p);
			db.exec(`CREATE TABLE unrelated (id INTEGER PRIMARY KEY, name TEXT);`);
			db.close();
			const res = validateAndRestore({ uploadedPath: p, originalFilename: 'wrong-schema.db' });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe('missing_required_table');
		});

		it('accepts a valid DB containing all REQUIRED_TABLES and returns a stagedPath', () => {
			const p = join(scratch, 'good.db');
			makeValidBackupDb(p);
			const res = validateAndRestore({ uploadedPath: p, originalFilename: 'good.db' });
			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(typeof res.stagedPath).toBe('string');
				expect(res.stagedPath.endsWith('.restore-pending')).toBe(true);
			}
		});

		it('does NOT rename or overwrite anything on success (caller owns the final rename)', () => {
			const p = join(scratch, 'good.db');
			makeValidBackupDb(p);
			const res = validateAndRestore({ uploadedPath: p, originalFilename: 'good.db' });
			expect(res.ok).toBe(true);
			// The staged path should not exist yet — the service only returns the path it would use.
			if (res.ok) {
				expect(existsSync(res.stagedPath)).toBe(false);
			}
		});

		it('accepts mixed-case .DB extensions', () => {
			const p = join(scratch, 'good.DB');
			makeValidBackupDb(p);
			const res = validateAndRestore({ uploadedPath: p, originalFilename: 'good.DB' });
			expect(res.ok).toBe(true);
		});
	});

	describe('createBackup', () => {
		it('creates a file named ip-cam-master-YYYYMMDD-HHMM.db in the destination dir', async () => {
			const { filename, absPath } = await createBackup(scratch);
			expect(filename).toMatch(/^ip-cam-master-\d{8}-\d{4}\.db$/);
			expect(absPath.endsWith(filename)).toBe(true);
			expect(existsSync(absPath)).toBe(true);
			expect(statSync(absPath).size).toBeGreaterThan(0);
		});

		it('produces a file that passes PRAGMA integrity_check', async () => {
			const { absPath } = await createBackup(scratch);
			const db = new Database(absPath, { readonly: true, fileMustExist: true });
			try {
				const result = db.pragma('integrity_check', { simple: true });
				expect(result).toBe('ok');
			} finally {
				db.close();
			}
		});

		it('copies the live data into the backup file', async () => {
			const { absPath } = await createBackup(scratch);
			const db = new Database(absPath, { readonly: true, fileMustExist: true });
			try {
				const row = db.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as
					| { value: string }
					| undefined;
				expect(row?.value).toBe('backup-roundtrip');
			} finally {
				db.close();
			}
		});
	});
});
