import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Redirect the updater env file to /tmp before importing the module so tests
// can run in environments where /run isn't writable (macOS dev).
process.env.IP_CAM_MASTER_UPDATER_ENV_FILE = `/tmp/ip-cam-master-update-test-${process.pid}.env`;

vi.mock('node:child_process', () => {
	const spawn = vi.fn();
	const execFile = vi.fn();
	return { spawn, execFile, default: { spawn, execFile } };
});

// createBackup is invoked first thing — mock it so tests don't touch real DB.
vi.mock('./backup', () => ({
	createBackup: vi.fn(async () => ({ filename: 'test.db', absPath: '/tmp/test-backup.db' }))
}));

// state-store is invoked to mark updateStatus='installing' — mock it.
vi.mock('./update-state-store', () => ({
	writeUpdateState: vi.fn()
}));

import { spawn, execFile } from 'node:child_process';
import {
	ensureUpdateScriptInstalled,
	spawnUpdateRun,
	tailUpdateLog,
	getDirtyFiles,
	UPDATER_UNIT_NAME,
	updaterEnvFilePath
} from './update-runner';

const UPDATER_ENV_FILE = updaterEnvFilePath();

describe('spawnUpdateRun (dedicated systemd unit)', () => {
	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		vi.mocked(spawn).mockReturnValue({
			unref: vi.fn(),
			on: vi.fn(),
			stdout: null,
			stderr: null
		} as unknown as ReturnType<typeof spawn>);
	});

	it('writes env file and starts the dedicated updater unit via systemctl', async () => {
		const result = await spawnUpdateRun({
			preSha: 'a'.repeat(40),
			preSchemaHash: 'deadbeef',
			targetSha: 'b'.repeat(40),
			trigger: 'manual'
		});

		expect(spawn).toHaveBeenCalledOnce();
		const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0];
		expect(cmd).toBe('systemctl');
		expect(args).toEqual(['start', '--no-block', UPDATER_UNIT_NAME]);
		expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });

		expect(existsSync(UPDATER_ENV_FILE)).toBe(true);
		const envBody = readFileSync(UPDATER_ENV_FILE, 'utf8');
		expect(envBody).toContain(`PRE_SHA=${'a'.repeat(40)}`);
		expect(envBody).toContain('PRE_SCHEMA_HASH=deadbeef');
		expect(envBody).toContain(`TARGET_SHA=${'b'.repeat(40)}`);
		expect(envBody).toContain('UPDATE_TRIGGER=manual');
		expect(envBody).toMatch(/LOG=\/tmp\/ip-cam-master-update-\d+\.log/);
		expect(envBody).toMatch(/EXITCODE_FILE=\/tmp\/ip-cam-master-update-\d+\.exitcode/);

		expect(result.logPath).toMatch(/^\/tmp\/ip-cam-master-update-\d+\.log$/);
		expect(result.exitcodeFile).toMatch(/^\/tmp\/ip-cam-master-update-\d+\.exitcode$/);
		expect(result.targetSha).toBe('b'.repeat(40));
	});

	it('detaches via child.unref()', async () => {
		const unrefMock = vi.fn();
		vi.mocked(spawn).mockReturnValue({
			unref: unrefMock,
			on: vi.fn(),
			stdout: null,
			stderr: null
		} as unknown as ReturnType<typeof spawn>);

		await spawnUpdateRun({ preSha: 'aaa', preSchemaHash: 'bbb' });
		expect(unrefMock).toHaveBeenCalledOnce();
	});

	it('never uses {shell: true}', async () => {
		await spawnUpdateRun({ preSha: 'abc', preSchemaHash: 'def' });
		const [, , opts] = vi.mocked(spawn).mock.calls[0];
		expect((opts as { shell?: boolean } | undefined)?.shell).toBeUndefined();
	});
});

describe('tailUpdateLog', () => {
	let tmpdir: string;

	beforeEach(() => {
		tmpdir = mkdtempSync(path.join(os.tmpdir(), 'update-tail-'));
	});

	afterEach(() => {
		try {
			rmSync(tmpdir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it('emits done with exitcode 0 = success', async () => {
		const logPath = path.join(tmpdir, 'run.log');
		const exitcodeFile = path.join(tmpdir, 'run.exitcode');
		writeFileSync(logPath, 'line one\n[stage=verify] ok\n');
		writeFileSync(exitcodeFile, '0\n');

		const controller = new AbortController();
		const events: Array<{ type: string; exitCode?: number; result?: string }> = [];
		for await (const ev of tailUpdateLog(logPath, exitcodeFile, controller.signal)) {
			events.push(ev);
			if (ev.type === 'done') break;
		}
		const done = events.find((e) => e.type === 'done');
		expect(done?.result).toBe('success');
	});

	it('maps exitcode 2 to rolled_back', async () => {
		const logPath = path.join(tmpdir, 'run.log');
		const exitcodeFile = path.join(tmpdir, 'run.exitcode');
		writeFileSync(logPath, '');
		writeFileSync(exitcodeFile, '2\n');
		const controller = new AbortController();
		const events: Array<{ type: string; result?: string }> = [];
		for await (const ev of tailUpdateLog(logPath, exitcodeFile, controller.signal)) {
			events.push(ev);
			if (ev.type === 'done') break;
		}
		expect(events.find((e) => e.type === 'done')?.result).toBe('rolled_back');
	});

	it('aborts promptly via signal', async () => {
		const logPath = path.join(tmpdir, 'run.log');
		const exitcodeFile = path.join(tmpdir, 'run.exitcode');
		writeFileSync(logPath, 'only line\n');

		const controller = new AbortController();
		const events: Array<{ type: string }> = [];
		const consumer = (async () => {
			for await (const ev of tailUpdateLog(logPath, exitcodeFile, controller.signal)) {
				events.push(ev);
				if (ev.type === 'log') controller.abort();
			}
		})();
		await Promise.race([
			consumer,
			new Promise((_, reject) => setTimeout(() => reject(new Error('abort timeout')), 3000))
		]);
		expect(events.some((e) => e.type === 'done')).toBe(false);
	});
});

describe('getDirtyFiles', () => {
	beforeEach(() => {
		vi.mocked(execFile).mockReset();
	});

	it('returns empty array on error (never throws)', async () => {
		vi.mocked(execFile).mockImplementation(
			((
				_cmd: string,
				_args: readonly string[],
				_opts: unknown,
				cb: (err: Error | null) => void
			) => {
				cb(new Error('boom'));
				return {} as ReturnType<typeof execFile>;
			}) as unknown as typeof execFile
		);
		const result = await getDirtyFiles();
		expect(result).toEqual([]);
	});
});

describe('ensureUpdateScriptInstalled', () => {
	it('is a no-op in dev mode', async () => {
		await expect(ensureUpdateScriptInstalled()).resolves.toBeUndefined();
	});

	it('scripts/update.sh exists in worktree (deploy artifact)', () => {
		const cwdScript = path.join(process.cwd(), 'scripts', 'update.sh');
		expect(existsSync(cwdScript)).toBe(true);
	});
});
