/**
 * Update run history — backed by the `update_runs` SQLite table
 * (UPD-AUTO-10). Replaces the JSON blob previously stored in
 * settings.update_run_history.
 *
 * Crash recovery: rows for in-flight updates start with status='running'
 * and are reconciled at boot via the on-disk exitcode file written by
 * scripts/update.sh. Same contract as the previous JSON-blob impl, so
 * callers don't need to change.
 *
 * One-time migration: on first read, if a legacy
 * settings.update_run_history blob exists, its entries are inserted
 * into update_runs and the settings row is deleted.
 */

import { readFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, sqlite } from '$lib/server/db/client';
import { updateRuns } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { getSetting, saveSetting } from './settings';

const LEGACY_HISTORY_KEY = 'update_run_history';
const MAX_DEFAULT_LIMIT = 10;

export type UpdateRunStatus = 'running' | 'success' | 'failed' | 'rolled_back';
export type UpdateRunTrigger = 'manual' | 'auto';

export type UpdateRunEntry = {
	id?: number;
	startedAt: string;
	finishedAt: string | null;
	preSha: string;
	postSha: string | null;
	result: UpdateRunStatus;
	logPath: string;
	unitName: string;
	backupPath?: string | null;
	stage?: string | null;
	errorMessage?: string | null;
	rollbackStage?: 'stage1' | 'stage2' | null;
	trigger?: UpdateRunTrigger;
	targetSha?: string | null;
};

let legacyMigrated = false;

async function maybeMigrateLegacy(): Promise<void> {
	if (legacyMigrated) return;
	legacyMigrated = true;

	const raw = await getSetting(LEGACY_HISTORY_KEY);
	if (!raw) return;

	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return;
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue;
			const e = entry as Partial<UpdateRunEntry>;
			db.insert(updateRuns)
				.values({
					startedAt: e.startedAt ?? new Date().toISOString(),
					finishedAt: e.finishedAt ?? null,
					preSha: e.preSha ?? null,
					postSha: e.postSha ?? null,
					targetSha: null,
					status: (e.result as UpdateRunStatus) ?? 'failed',
					stage: e.stage ?? null,
					errorMessage: e.errorMessage ?? null,
					rollbackStage: e.rollbackStage ?? null,
					unitName: e.unitName ?? null,
					logPath: e.logPath ?? null,
					backupPath: e.backupPath ?? null,
					trigger: 'manual'
				})
				.run();
		}
		// Drop the legacy blob. saveSetting('', '') would not delete; use raw SQL.
		sqlite.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_HISTORY_KEY);
		console.log(`[update-history] migrated ${parsed.length} legacy entries to update_runs`);
	} catch (err) {
		console.error('[update-history] legacy migration failed:', (err as Error).message);
	}
}

function rowToEntry(row: typeof updateRuns.$inferSelect): UpdateRunEntry {
	return {
		id: row.id,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		preSha: row.preSha ?? '',
		postSha: row.postSha,
		result: row.status as UpdateRunStatus,
		logPath: row.logPath ?? '',
		unitName: row.unitName ?? '',
		backupPath: row.backupPath,
		stage: row.stage,
		errorMessage: row.errorMessage,
		rollbackStage: row.rollbackStage as 'stage1' | 'stage2' | null,
		trigger: (row.trigger ?? 'manual') as UpdateRunTrigger,
		targetSha: row.targetSha
	};
}

/**
 * Insert a new entry. Returns the inserted row id.
 */
export async function appendUpdateRun(entry: UpdateRunEntry): Promise<number> {
	await maybeMigrateLegacy();
	const result = db
		.insert(updateRuns)
		.values({
			startedAt: entry.startedAt,
			finishedAt: entry.finishedAt,
			preSha: entry.preSha,
			postSha: entry.postSha,
			targetSha: entry.targetSha ?? null,
			status: entry.result,
			stage: entry.stage ?? null,
			errorMessage: entry.errorMessage ?? null,
			rollbackStage: entry.rollbackStage ?? null,
			unitName: entry.unitName,
			logPath: entry.logPath,
			backupPath: entry.backupPath ?? null,
			trigger: entry.trigger ?? 'manual'
		})
		.returning({ id: updateRuns.id })
		.all();
	return result[0]?.id ?? 0;
}

/**
 * Patch an existing entry by unitName. No-op if not found.
 */
export async function updateUpdateRun(
	unitName: string,
	patch: Partial<UpdateRunEntry>
): Promise<void> {
	await maybeMigrateLegacy();
	const updates: Partial<typeof updateRuns.$inferInsert> = {};
	if (patch.finishedAt !== undefined) updates.finishedAt = patch.finishedAt;
	if (patch.preSha !== undefined) updates.preSha = patch.preSha;
	if (patch.postSha !== undefined) updates.postSha = patch.postSha;
	if (patch.targetSha !== undefined) updates.targetSha = patch.targetSha;
	if (patch.result !== undefined) updates.status = patch.result;
	if (patch.stage !== undefined) updates.stage = patch.stage;
	if (patch.errorMessage !== undefined) updates.errorMessage = patch.errorMessage;
	if (patch.rollbackStage !== undefined) updates.rollbackStage = patch.rollbackStage;
	if (patch.logPath !== undefined) updates.logPath = patch.logPath;
	if (patch.backupPath !== undefined) updates.backupPath = patch.backupPath;
	if (Object.keys(updates).length === 0) return;

	db.update(updateRuns).set(updates).where(eq(updateRuns.unitName, unitName)).run();
}

export async function readUpdateRuns(limit: number = MAX_DEFAULT_LIMIT): Promise<UpdateRunEntry[]> {
	await maybeMigrateLegacy();
	const rows = db.select().from(updateRuns).orderBy(desc(updateRuns.startedAt)).limit(limit).all();
	return rows.map(rowToEntry);
}

/**
 * Reconcile any rows still marked `running` against their on-disk exit
 * code files. The Node process that started the run may have died
 * mid-flight (during its own update), leaving the row stuck. On boot,
 * we patch each one based on the exitcode file and the final marker
 * line in the log.
 */
export async function reconcileRunningEntries(): Promise<number> {
	await maybeMigrateLegacy();
	const rows = db
		.select()
		.from(updateRuns)
		.where(eq(updateRuns.status, 'running'))
		.all();

	let patched = 0;
	for (const row of rows) {
		if (!row.logPath) continue;
		const exitcodePath = row.logPath.replace(/\.log$/, '.exitcode');
		if (!existsSync(exitcodePath)) continue;
		let code: number;
		try {
			code = Number.parseInt(readFileSync(exitcodePath, 'utf-8').trim(), 10);
		} catch {
			continue;
		}

		const result: UpdateRunStatus =
			code === 0 ? 'success' : code === 2 ? 'rolled_back' : 'failed';

		const updates: Partial<typeof updateRuns.$inferInsert> = {
			status: result,
			finishedAt: new Date().toISOString()
		};
		if (code === 0) {
			const marker = readMarkerLine(row.logPath);
			if (marker) {
				const m = marker.match(/-> ([0-9a-f]{40})/);
				if (m) updates.postSha = m[1];
			}
		}

		db.update(updateRuns).set(updates).where(eq(updateRuns.id, row.id)).run();
		patched++;
	}
	return patched;
}

function readMarkerLine(logPath: string): string | null {
	try {
		const content = readFileSync(logPath, 'utf-8');
		const lines = content.trim().split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].includes('UPDATE_RESULT')) return lines[i];
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Remove stale entries + log/exitcode files older than `maxAgeDays`.
 * Drops the row from update_runs if older than cutoff. Sweeps /tmp for
 * orphaned log files older than cutoff that aren't referenced by any
 * remaining row.
 */
export async function cleanupOldUpdateLogs(maxAgeDays: number = 30): Promise<{
	entriesDropped: number;
	filesRemoved: number;
}> {
	await maybeMigrateLegacy();
	const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const allRows = db.select().from(updateRuns).all();

	const referencedFiles = new Set<string>();
	let entriesDropped = 0;
	let filesRemoved = 0;

	for (const row of allRows) {
		const startedMs = Date.parse(row.startedAt);
		if (Number.isFinite(startedMs) && startedMs < cutoffMs) {
			db.delete(updateRuns).where(eq(updateRuns.id, row.id)).run();
			entriesDropped++;
			if (row.logPath) {
				const exitcode = row.logPath.replace(/\.log$/, '.exitcode');
				for (const p of [row.logPath, exitcode]) {
					try {
						if (existsSync(p)) {
							unlinkSync(p);
							filesRemoved++;
						}
					} catch {
						/* tolerate */
					}
				}
			}
			continue;
		}
		if (row.logPath) {
			referencedFiles.add(row.logPath);
			referencedFiles.add(row.logPath.replace(/\.log$/, '.exitcode'));
		}
	}

	try {
		const tmpFiles = readdirSync('/tmp');
		for (const name of tmpFiles) {
			if (!/^ip-cam-master-update-\d+\.(log|exitcode)$/.test(name)) continue;
			const full = join('/tmp', name);
			if (referencedFiles.has(full)) continue;
			try {
				const stat = statSync(full);
				if (stat.mtimeMs < cutoffMs) {
					unlinkSync(full);
					filesRemoved++;
				}
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* /tmp unreadable */
	}

	return { entriesDropped, filesRemoved };
}
