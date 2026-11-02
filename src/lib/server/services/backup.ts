import { sqlite, DB_ABS_PATH } from '$lib/server/db/client';
import Database from 'better-sqlite3';
import { statSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Backup service — createBackup() writes a fresh snapshot of the live SQLite DB,
 * validateAndRestore() performs read-only validation of an uploaded .db file.
 *
 * Design notes:
 * - createBackup() uses better-sqlite3's `db.backup()` which runs the SQLite
 *   online backup API — safe to call while the DB is in use.
 * - validateAndRestore() is deliberately side-effect-free on the live DB:
 *   it opens the uploaded file read-only, runs PRAGMA integrity_check, checks
 *   that all REQUIRED_TABLES exist, and returns the staging path the API route
 *   will rename over DB_ABS_PATH. It does NOT copy, rename, or touch the live DB.
 *   The caller (API route) is responsible for the final atomic rename + exit.
 *   This split keeps the service unit-testable without killing the test runner.
 */

export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

export const REQUIRED_TABLES = [
	'settings',
	'containers',
	'cameras',
	'credentials',
	'users',
	'events'
] as const;

export type RestoreError =
	| 'invalid_filename'
	| 'file_too_large'
	| 'integrity_check_failed'
	| 'missing_required_table'
	| 'io_error';

export type RestoreResult =
	| { ok: true; stagedPath: string }
	| { ok: false; error: RestoreError; detail?: string };

/**
 * Format a Date as `YYYYMMDD-HHMM` in local time, zero-padded.
 * Example: 2026-04-10 14:32:05 → "20260410-1432".
 */
export function formatBackupTimestamp(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Create a backup snapshot of the live DB. Returns the filename (for
 * Content-Disposition) and absolute path on disk (for streaming + cleanup).
 *
 * @param destDir Optional override for the destination directory (used by tests).
 *                Defaults to `./data/backups`.
 */
export async function createBackup(
	destDir?: string
): Promise<{ filename: string; absPath: string }> {
	const dir = destDir ?? resolve('data/backups');
	mkdirSync(dir, { recursive: true });
	const filename = `ip-cam-master-${formatBackupTimestamp()}.db`;
	const absPath = resolve(dir, filename);
	await sqlite.backup(absPath);
	return { filename, absPath };
}

/**
 * Validate an uploaded .db file without touching the live database.
 *
 * Checks (in order):
 *   1. Filename ends with `.db` (case-insensitive)
 *   2. File size ≤ MAX_BACKUP_BYTES
 *   3. PRAGMA integrity_check returns 'ok'
 *   4. All REQUIRED_TABLES exist in sqlite_master
 *
 * On success, returns the staging path the caller should write the bytes to
 * before renaming over DB_ABS_PATH. The staging path is guaranteed to live on
 * the same filesystem as the live DB (POSIX atomic rename requirement).
 */
export function validateAndRestore(opts: {
	uploadedPath: string;
	originalFilename: string;
}): RestoreResult {
	// 1) filename check
	if (!opts.originalFilename.toLowerCase().endsWith('.db')) {
		return { ok: false, error: 'invalid_filename' };
	}

	// 2) size check
	let size: number;
	try {
		size = statSync(opts.uploadedPath).size;
	} catch (e) {
		return { ok: false, error: 'io_error', detail: (e as Error).message };
	}
	if (size > MAX_BACKUP_BYTES) {
		return { ok: false, error: 'file_too_large' };
	}

	// 3) integrity check via a temporary read-only handle
	let tmp: Database.Database | null = null;
	try {
		tmp = new Database(opts.uploadedPath, { readonly: true, fileMustExist: true });
		const result = tmp.pragma('integrity_check', { simple: true });
		if (result !== 'ok') {
			return { ok: false, error: 'integrity_check_failed', detail: String(result) };
		}

		// 4) required-tables check
		const rows = tmp
			.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
			.all() as { name: string }[];
		const present = new Set(rows.map((r) => r.name));
		for (const t of REQUIRED_TABLES) {
			if (!present.has(t)) {
				return { ok: false, error: 'missing_required_table', detail: t };
			}
		}
	} catch (e) {
		return { ok: false, error: 'integrity_check_failed', detail: (e as Error).message };
	} finally {
		tmp?.close();
	}

	// Staging path lives next to the live DB on the SAME filesystem so rename()
	// is atomic. The API route writes bytes here, then renameSync()'s over the
	// live DB, then schedules process.exit(0).
	const stagedPath = `${DB_ABS_PATH}.restore-pending`;
	return { ok: true, stagedPath };
}
