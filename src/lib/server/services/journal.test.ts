import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string }
) => void;
type ExecFileCall = {
	file: string;
	args: string[];
	options: { maxBuffer?: number };
};

const execFileCalls: ExecFileCall[] = [];
let execFileStdout = '';
let execFileError: Error | null = null;

vi.mock('node:child_process', () => ({
	execFile: (
		file: string,
		args: string[],
		options: { maxBuffer?: number },
		cb: ExecFileCallback
	) => {
		execFileCalls.push({ file, args, options });
		if (execFileError) {
			cb(execFileError, { stdout: '', stderr: '' });
		} else {
			cb(null, { stdout: execFileStdout, stderr: '' });
		}
	}
}));

import { readJournal } from './journal';

beforeEach(() => {
	execFileCalls.length = 0;
	execFileStdout = '';
	execFileError = null;
});

describe('readJournal', () => {
	it('calls execFile with exact argv including -p debug for severity=all', async () => {
		execFileStdout = '';
		await readJournal(200, 'all');

		expect(execFileCalls).toHaveLength(1);
		const call = execFileCalls[0];
		expect(call.file).toBe('journalctl');
		expect(call.args).toEqual([
			'-u',
			'ip-cam-master',
			'-n',
			'200',
			'-o',
			'json',
			'--no-pager',
			'-p',
			'debug'
		]);
	});

	it('maps severity=error to syslog name "err" (NOT "error")', async () => {
		await readJournal(100, 'error');
		const call = execFileCalls[0];
		expect(call.args).toContain('-p');
		expect(call.args).toContain('err');
		expect(call.args).not.toContain('error');
	});

	it('maps severity=warning to "-p warning"', async () => {
		await readJournal(100, 'warning');
		const args = execFileCalls[0].args;
		const pIdx = args.indexOf('-p');
		expect(args[pIdx + 1]).toBe('warning');
	});

	it('maps severity=info to "-p info"', async () => {
		await readJournal(100, 'info');
		const args = execFileCalls[0].args;
		const pIdx = args.indexOf('-p');
		expect(args[pIdx + 1]).toBe('info');
	});

	it('clamps lines: 0 becomes 1', async () => {
		await readJournal(0, 'all');
		const args = execFileCalls[0].args;
		const nIdx = args.indexOf('-n');
		expect(args[nIdx + 1]).toBe('1');
	});

	it('clamps lines: 5000 becomes 1000', async () => {
		await readJournal(5000, 'all');
		const args = execFileCalls[0].args;
		const nIdx = args.indexOf('-n');
		expect(args[nIdx + 1]).toBe('1000');
	});

	it('clamps lines: 3.7 becomes 3 (Math.floor)', async () => {
		await readJournal(3.7, 'all');
		const args = execFileCalls[0].args;
		const nIdx = args.indexOf('-n');
		expect(args[nIdx + 1]).toBe('3');
	});

	it('passes maxBuffer of at least 16MB to execFile', async () => {
		await readJournal(100, 'all');
		const opts = execFileCalls[0].options;
		expect(opts.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
	});

	it('parses NDJSON: two lines of valid JSON → 2 JournalEntry objects', async () => {
		const line1 = JSON.stringify({
			__REALTIME_TIMESTAMP: '1712750400123456',
			PRIORITY: '6',
			MESSAGE: 'first',
			_PID: '1234'
		});
		const line2 = JSON.stringify({
			__REALTIME_TIMESTAMP: '1712750401456789',
			PRIORITY: '3',
			MESSAGE: 'second',
			_PID: '1234'
		});
		execFileStdout = `${line1}\n${line2}\n`;

		const entries = await readJournal(100, 'all');
		expect(entries).toHaveLength(2);
		expect(entries[0].message).toBe('first');
		expect(entries[1].message).toBe('second');
	});

	it('converts __REALTIME_TIMESTAMP microseconds to milliseconds', async () => {
		execFileStdout =
			JSON.stringify({
				__REALTIME_TIMESTAMP: '1712750400123456',
				PRIORITY: '6',
				MESSAGE: 'x',
				_PID: '1'
			}) + '\n';
		const entries = await readJournal(1, 'all');
		expect(entries[0].timestamp).toBe(1712750400123);
	});

	it('handles MESSAGE as byte array (non-UTF-8 path)', async () => {
		execFileStdout =
			JSON.stringify({
				__REALTIME_TIMESTAMP: '1712750400123456',
				PRIORITY: '6',
				MESSAGE: [72, 105],
				_PID: '1'
			}) + '\n';
		const entries = await readJournal(1, 'all');
		expect(entries[0].message).toBe('Hi');
	});

	it('handles missing _PID → pid: null', async () => {
		execFileStdout =
			JSON.stringify({
				__REALTIME_TIMESTAMP: '1712750400123456',
				PRIORITY: '6',
				MESSAGE: 'x'
			}) + '\n';
		const entries = await readJournal(1, 'all');
		expect(entries[0].pid).toBeNull();
	});

	it('parses PRIORITY string to number', async () => {
		execFileStdout =
			JSON.stringify({
				__REALTIME_TIMESTAMP: '1712750400123456',
				PRIORITY: '3',
				MESSAGE: 'err',
				_PID: '1'
			}) + '\n';
		const entries = await readJournal(1, 'all');
		expect(entries[0].priority).toBe(3);
	});

	it('skips empty/whitespace-only lines in stdout', async () => {
		const line = JSON.stringify({
			__REALTIME_TIMESTAMP: '1712750400123456',
			PRIORITY: '6',
			MESSAGE: 'only',
			_PID: '1'
		});
		execFileStdout = `\n${line}\n   \n\n`;
		const entries = await readJournal(1, 'all');
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toBe('only');
	});

	it('propagates execFile rejection on non-zero exit', async () => {
		execFileError = new Error('journalctl: No such unit');
		await expect(readJournal(10, 'all')).rejects.toThrow('No such unit');
	});
});
