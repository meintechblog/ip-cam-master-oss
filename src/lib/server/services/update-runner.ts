/**
 * Self-update runner — spawns the dedicated systemd unit
 * `ip-cam-master-updater.service` (UPD-AUTO-12 / D-01 in CONTEXT).
 *
 * Switched from `systemd-run` transient units to a permanent oneshot
 * unit so the updater lives in a sibling cgroup. With the previous
 * pattern, `systemctl stop ip-cam-master` (the `stop` stage of the
 * pipeline) would also kill the spawning systemd-run unit, leaving
 * the update half-applied with no rollback driver.
 *
 * The unit's WorkingDirectory + ExecStart point at /opt/ip-cam-master
 * and /usr/local/bin/ip-cam-master-update.sh, which we keep in sync
 * with the running install via ensureUpdateScriptInstalled() and
 * ensureUpdaterUnitInstalled() at app boot.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fsp, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createBackup } from './backup';
import { writeUpdateState } from './update-state-store';

const execFileAsync = promisify(execFile);

export const INSTALLED_SCRIPT_PATH = '/usr/local/bin/ip-cam-master-update.sh';
export const UPDATER_UNIT_NAME = 'ip-cam-master-updater.service';
export const UPDATER_UNIT_PATH = `/etc/systemd/system/${UPDATER_UNIT_NAME}`;
export function updaterEnvFilePath(): string {
	return process.env.IP_CAM_MASTER_UPDATER_ENV_FILE ?? '/run/ip-cam-master-update.env';
}
export const UPDATER_ENV_FILE = updaterEnvFilePath();

const CANDIDATE_INSTALL_DIRS = ['/opt/ip-cam-master', process.cwd()];

function findInstallDir(): string | null {
	for (const dir of CANDIDATE_INSTALL_DIRS) {
		if (existsSync(path.join(dir, '.git'))) return dir;
	}
	return null;
}

/**
 * Copy scripts/update.sh from the install dir to /usr/local/bin.
 * Best-effort: silent in dev mode, errors logged but not thrown.
 */
export async function ensureUpdateScriptInstalled(): Promise<void> {
	const installDir = findInstallDir();
	if (!installDir) return;

	const sourcePath = path.join(installDir, 'scripts', 'update.sh');
	if (!existsSync(sourcePath)) return;

	try {
		const sourceStat = await fsp.stat(sourcePath);
		let shouldCopy = true;
		if (existsSync(INSTALLED_SCRIPT_PATH)) {
			const targetStat = await fsp.stat(INSTALLED_SCRIPT_PATH);
			if (targetStat.mtimeMs >= sourceStat.mtimeMs) {
				shouldCopy = false;
			}
		}
		if (shouldCopy) {
			await fsp.copyFile(sourcePath, INSTALLED_SCRIPT_PATH);
			await fsp.chmod(INSTALLED_SCRIPT_PATH, 0o755);
		}
	} catch (err) {
		console.error('[update-runner] ensureUpdateScriptInstalled failed:', err);
	}
}

/**
 * Install/refresh the dedicated systemd unit for the updater.
 * Best-effort. Reads scripts/update/ip-cam-master-updater.service
 * from the install dir (delivered by W3-T1) and copies it into
 * /etc/systemd/system/. Runs daemon-reload + enable on change.
 *
 * Idempotent: skips if the target file is at least as new as the source.
 */
export async function ensureUpdaterUnitInstalled(): Promise<void> {
	const installDir = findInstallDir();
	if (!installDir) return;

	const sourcePath = path.join(installDir, 'scripts', 'update', 'ip-cam-master-updater.service');
	if (!existsSync(sourcePath)) return;

	try {
		const sourceStat = await fsp.stat(sourcePath);
		let shouldCopy = true;
		if (existsSync(UPDATER_UNIT_PATH)) {
			const targetStat = await fsp.stat(UPDATER_UNIT_PATH);
			if (targetStat.mtimeMs >= sourceStat.mtimeMs) {
				shouldCopy = false;
			}
		}
		if (!shouldCopy) return;

		await fsp.copyFile(sourcePath, UPDATER_UNIT_PATH);
		await fsp.chmod(UPDATER_UNIT_PATH, 0o644);

		await execFileAsync('systemctl', ['daemon-reload']);
		await execFileAsync('systemctl', ['enable', UPDATER_UNIT_NAME]).catch(() => {
			/* enable is non-essential; ignore */
		});
		console.log(`[update-runner] installed/updated ${UPDATER_UNIT_NAME}`);
	} catch (err) {
		console.error('[update-runner] ensureUpdaterUnitInstalled failed:', err);
	}
}

export type SpawnedRun = {
	logPath: string;
	exitcodeFile: string;
	unitName: string;
	startedAt: string;
	backupPath: string | null;
	targetSha: string | null;
};

function hhmmss(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type SpawnUpdateRunOptions = {
	preSha: string;
	preSchemaHash: string;
	targetSha?: string | null;
	trigger?: 'manual' | 'auto';
};

/**
 * Take an auto-backup, write the LOG/EXITCODE_FILE/PRE_SHA env file,
 * and start the dedicated updater unit via `systemctl start --no-block`.
 *
 * Aborts the update with a thrown error if the backup fails — we
 * refuse to proceed without a known-good rollback target.
 */
export async function spawnUpdateRun(options: SpawnUpdateRunOptions): Promise<SpawnedRun> {
	const { preSha, preSchemaHash, targetSha = null, trigger = 'manual' } = options;
	const ts = Date.now();
	const logPath = `/tmp/ip-cam-master-update-${ts}.log`;
	const exitcodeFile = `/tmp/ip-cam-master-update-${ts}.exitcode`;
	const unitName = `${UPDATER_UNIT_NAME}-${ts}`; // logical name for history
	const startedAt = new Date(ts).toISOString();

	writeFileSync(logPath, `[${hhmmss()}] Pre-update auto-backup...\n`);

	let backupPath: string | null = null;
	try {
		const backup = await createBackup();
		backupPath = backup.absPath;
		appendFileSync(logPath, `[${hhmmss()}] Backup created: ${backup.absPath}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		appendFileSync(
			logPath,
			`[${hhmmss()}] BACKUP FAILED — update aborted (no known-good restore point): ${msg}\n`
		);
		appendFileSync(logPath, `=== UPDATE_RESULT: failed (backup-aborted) ===\n`);
		writeFileSync(exitcodeFile, '1\n');
		throw new Error(`Auto-backup failed: ${msg}`);
	}

	// Write env file the systemd unit reads via EnvironmentFile=. The unit's
	// ExecStart is hard-coded to call /usr/local/bin/ip-cam-master-update.sh
	// with no args; everything passes through env.
	const envContent = [
		`LOG=${logPath}`,
		`EXITCODE_FILE=${exitcodeFile}`,
		`PRE_SHA=${preSha}`,
		`PRE_SCHEMA_HASH=${preSchemaHash}`,
		`TARGET_SHA=${targetSha ?? ''}`,
		`UPDATE_TRIGGER=${trigger}`,
		''
	].join('\n');
	writeFileSync(updaterEnvFilePath(), envContent, { mode: 0o600 });

	// Mark state.json as installing — the bash script picks up the rest.
	writeUpdateState({
		updateStatus: 'installing',
		targetSha,
		updateStartedAt: startedAt
	});

	const child: ChildProcess = spawn(
		'systemctl',
		['start', '--no-block', UPDATER_UNIT_NAME],
		{ detached: true, stdio: 'ignore' }
	);
	child.unref();

	return { logPath, exitcodeFile, unitName, startedAt, backupPath, targetSha };
}

export type TailEvent =
	| { type: 'log'; line: string }
	| { type: 'done'; exitCode: number; result: 'success' | 'failed' | 'rolled_back' };

function exitCodeToResult(code: number): 'success' | 'failed' | 'rolled_back' {
	if (code === 0) return 'success';
	if (code === 2) return 'rolled_back';
	return 'failed';
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

export async function* tailUpdateLog(
	logPath: string,
	exitcodeFile: string,
	signal: AbortSignal
): AsyncIterable<TailEvent> {
	let position = 0;
	let buffer = '';

	while (!signal.aborted) {
		if (existsSync(logPath)) {
			try {
				const handle = await fsp.open(logPath, 'r');
				try {
					const stat = await handle.stat();
					if (stat.size > position) {
						const toRead = stat.size - position;
						const buf = Buffer.alloc(toRead);
						await handle.read(buf, 0, toRead, position);
						position = stat.size;
						buffer += buf.toString('utf8');
						let idx: number;
						while ((idx = buffer.indexOf('\n')) !== -1) {
							const line = buffer.slice(0, idx);
							buffer = buffer.slice(idx + 1);
							yield { type: 'log', line };
						}
					} else if (stat.size < position) {
						position = 0;
						buffer = '';
					}
				} finally {
					await handle.close();
				}
			} catch {
				/* transient */
			}
		}

		if (existsSync(exitcodeFile)) {
			if (existsSync(logPath)) {
				try {
					const handle = await fsp.open(logPath, 'r');
					try {
						const stat = await handle.stat();
						if (stat.size > position) {
							const toRead = stat.size - position;
							const buf = Buffer.alloc(toRead);
							await handle.read(buf, 0, toRead, position);
							position = stat.size;
							buffer += buf.toString('utf8');
							let idx: number;
							while ((idx = buffer.indexOf('\n')) !== -1) {
								const line = buffer.slice(0, idx);
								buffer = buffer.slice(idx + 1);
								yield { type: 'log', line };
							}
						}
					} finally {
						await handle.close();
					}
				} catch {
					/* ignore */
				}
			}
			if (buffer.length > 0) {
				yield { type: 'log', line: buffer };
				buffer = '';
			}
			try {
				const raw = (await fsp.readFile(exitcodeFile, 'utf8')).trim();
				const exitCode = Number.parseInt(raw, 10);
				const safeCode = Number.isFinite(exitCode) ? exitCode : 1;
				yield { type: 'done', exitCode: safeCode, result: exitCodeToResult(safeCode) };
			} catch {
				yield { type: 'done', exitCode: 1, result: 'failed' };
			}
			return;
		}

		await sleepAbortable(500, signal);
	}
}

export async function getDirtyFiles(): Promise<string[]> {
	const installDir = findInstallDir();
	if (!installDir) return [];
	try {
		const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: installDir });
		return stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}
