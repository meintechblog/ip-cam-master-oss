import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '$lib/server/db/schema';

// vi.mock factories are hoisted above all imports — keep no top-level state in
// them. We initialize the in-memory DB inside the factory and re-import it
// via dynamic import in the test body.
vi.mock('$lib/server/db/client', () => {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE update_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			pre_sha TEXT,
			post_sha TEXT,
			target_sha TEXT,
			status TEXT NOT NULL DEFAULT 'running',
			stage TEXT,
			error_message TEXT,
			rollback_stage TEXT,
			unit_name TEXT,
			log_path TEXT,
			backup_path TEXT,
			trigger TEXT NOT NULL DEFAULT 'manual'
		);
		CREATE TABLE settings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL UNIQUE,
			value TEXT NOT NULL,
			encrypted INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT
		);
	`);
	const db = drizzle(sqlite, { schema });
	return { db, sqlite };
});

vi.mock('./settings', () => ({
	getSetting: vi.fn(async () => null),
	saveSetting: vi.fn(async () => undefined)
}));

import { sqlite } from '$lib/server/db/client';
import {
	appendUpdateRun,
	updateUpdateRun,
	readUpdateRuns,
	type UpdateRunEntry
} from './update-history';

function makeEntry(overrides: Partial<UpdateRunEntry> = {}): UpdateRunEntry {
	return {
		startedAt: '2026-04-10T12:00:00.000Z',
		finishedAt: null,
		preSha: 'a'.repeat(40),
		postSha: null,
		result: 'running',
		logPath: '/tmp/ip-cam-master-update-1.log',
		unitName: 'ip-cam-master-update-1',
		trigger: 'manual',
		...overrides
	};
}

describe('update-history (update_runs table)', () => {
	beforeEach(() => {
		sqlite.exec('DELETE FROM update_runs');
	});

	it('appendUpdateRun inserts a row and returns its id', async () => {
		const id = await appendUpdateRun(makeEntry());
		expect(id).toBeGreaterThan(0);
		const rows = await readUpdateRuns();
		expect(rows).toHaveLength(1);
		expect(rows[0].unitName).toBe('ip-cam-master-update-1');
		expect(rows[0].result).toBe('running');
	});

	it('readUpdateRuns is reverse-chronological by startedAt', async () => {
		await appendUpdateRun(makeEntry({ unitName: 'u1', startedAt: '2026-04-10T10:00:00.000Z' }));
		await appendUpdateRun(makeEntry({ unitName: 'u2', startedAt: '2026-04-10T11:00:00.000Z' }));
		await appendUpdateRun(makeEntry({ unitName: 'u3', startedAt: '2026-04-10T12:00:00.000Z' }));
		const rows = await readUpdateRuns();
		expect(rows.map((r) => r.unitName)).toEqual(['u3', 'u2', 'u1']);
	});

	it('readUpdateRuns honours the limit parameter', async () => {
		for (let i = 1; i <= 8; i++) {
			await appendUpdateRun(
				makeEntry({ unitName: `u${i}`, startedAt: `2026-04-10T1${i}:00:00.000Z` })
			);
		}
		const rows = await readUpdateRuns(5);
		expect(rows).toHaveLength(5);
	});

	it('updateUpdateRun patches by unitName, leaves other rows untouched', async () => {
		await appendUpdateRun(makeEntry({ unitName: 'u1' }));
		await appendUpdateRun(makeEntry({ unitName: 'u2' }));
		await updateUpdateRun('u2', {
			finishedAt: '2026-04-10T12:05:00.000Z',
			result: 'success',
			postSha: 'b'.repeat(40)
		});
		const rows = await readUpdateRuns();
		const u2 = rows.find((r) => r.unitName === 'u2')!;
		expect(u2.finishedAt).toBe('2026-04-10T12:05:00.000Z');
		expect(u2.result).toBe('success');
		expect(u2.postSha).toBe('b'.repeat(40));
		// preSha preserved (not in patch)
		expect(u2.preSha).toBe('a'.repeat(40));
		// u1 untouched
		const u1 = rows.find((r) => r.unitName === 'u1')!;
		expect(u1.result).toBe('running');
	});

	it('updateUpdateRun is a no-op when unitName not found', async () => {
		await appendUpdateRun(makeEntry({ unitName: 'u1' }));
		await expect(updateUpdateRun('nonexistent', { result: 'success' })).resolves.toBeUndefined();
		const rows = await readUpdateRuns();
		expect(rows).toHaveLength(1);
		expect(rows[0].result).toBe('running');
	});
});
