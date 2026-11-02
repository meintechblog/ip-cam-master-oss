import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.fn();
const readFileMock = vi.fn();

vi.mock('node:child_process', () => ({
	execFile: (
		file: string,
		args: readonly string[],
		cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
	) => {
		execFileMock(file, args)
			.then((stdout: string) => cb(null, { stdout, stderr: '' }))
			.catch((err: Error) => cb(err, { stdout: '', stderr: '' }));
	}
}));

vi.mock('node:fs/promises', () => ({
	readFile: (path: string, encoding: string) => readFileMock(path, encoding)
}));

import {
	getDiskUsage,
	getMemoryUsage,
	getServiceStatus
} from './host-metrics';

describe('host-metrics service', () => {
	beforeEach(() => {
		execFileMock.mockReset();
		readFileMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('getDiskUsage', () => {
		it('parses df output with header + row', async () => {
			execFileMock.mockResolvedValueOnce(
				'       1B-blocks         Used        Avail Use%\n     53687091200  12884901888  40802189312   24%\n'
			);

			const result = await getDiskUsage('/');

			expect(execFileMock).toHaveBeenCalledWith('df', [
				'-B1',
				'--output=size,used,avail,pcent',
				'/'
			]);
			expect(result).toEqual({
				totalBytes: 53687091200,
				usedBytes: 12884901888,
				availableBytes: 40802189312,
				percentUsed: 24
			});
		});

		it('defaults to root path when none provided', async () => {
			execFileMock.mockResolvedValueOnce(
				'       1B-blocks         Used        Avail Use%\n       1000000000    500000000    500000000   50%\n'
			);

			const result = await getDiskUsage();

			expect(execFileMock).toHaveBeenCalledWith('df', [
				'-B1',
				'--output=size,used,avail,pcent',
				'/'
			]);
			expect(result.percentUsed).toBe(50);
		});
	});

	describe('getMemoryUsage', () => {
		it('uses MemAvailable (not MemFree) and rounds percent to 1 decimal', async () => {
			readFileMock.mockResolvedValueOnce(
				'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:   10000000 kB\n'
			);

			const result = await getMemoryUsage();

			expect(readFileMock).toHaveBeenCalledWith('/proc/meminfo', 'utf8');
			expect(result.totalBytes).toBe(16000000 * 1024);
			expect(result.availableBytes).toBe(10000000 * 1024);
			expect(result.usedBytes).toBe(6000000 * 1024);
			expect(result.percentUsed).toBe(37.5);
		});

		it('falls back to MemFree when MemAvailable is absent', async () => {
			readFileMock.mockResolvedValueOnce(
				'MemTotal:       8000000 kB\nMemFree:         2000000 kB\n'
			);

			const result = await getMemoryUsage();

			expect(result.availableBytes).toBe(2000000 * 1024);
			expect(result.usedBytes).toBe(6000000 * 1024);
			expect(result.percentUsed).toBe(75);
		});

		it('returns zero percent when total is zero', async () => {
			readFileMock.mockResolvedValueOnce('SomeKey:    0 kB\n');

			const result = await getMemoryUsage();

			expect(result.totalBytes).toBe(0);
			expect(result.percentUsed).toBe(0);
		});
	});

	describe('getServiceStatus', () => {
		it('parses active service and computes positive uptime', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-10T13:00:00Z'));

			execFileMock.mockResolvedValueOnce(
				'ActiveState=active\nSubState=running\nActiveEnterTimestamp=Thu 2026-04-10 14:32:11 CEST\nMainPID=1234\nResult=success\n'
			);

			const result = await getServiceStatus();

			expect(execFileMock).toHaveBeenCalledWith('systemctl', [
				'show',
				'ip-cam-master',
				'--property=ActiveState,SubState,ActiveEnterTimestamp,MainPID,Result',
				'--no-pager'
			]);
			expect(result.state).toBe('active');
			expect(result.subState).toBe('running');
			expect(result.mainPid).toBe(1234);
			expect(result.result).toBe('success');
			expect(result.uptimeSeconds).not.toBeNull();
			expect(result.uptimeSeconds!).toBeGreaterThanOrEqual(0);
		});

		it('returns null uptime when service is inactive and pid zero becomes null', async () => {
			execFileMock.mockResolvedValueOnce(
				'ActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\nMainPID=0\nResult=success\n'
			);

			const result = await getServiceStatus();

			expect(result.state).toBe('inactive');
			expect(result.subState).toBe('dead');
			expect(result.mainPid).toBeNull();
			expect(result.uptimeSeconds).toBeNull();
		});

		it('returns null uptime when state is not active even if timestamp present', async () => {
			execFileMock.mockResolvedValueOnce(
				'ActiveState=failed\nSubState=failed\nActiveEnterTimestamp=Thu 2026-04-10 14:32:11 CEST\nMainPID=0\nResult=exit-code\n'
			);

			const result = await getServiceStatus();

			expect(result.state).toBe('failed');
			expect(result.result).toBe('exit-code');
			expect(result.uptimeSeconds).toBeNull();
		});

		it('coerces unknown ActiveState to "unknown"', async () => {
			execFileMock.mockResolvedValueOnce(
				'ActiveState=reloading\nSubState=reload\nActiveEnterTimestamp=\nMainPID=42\nResult=success\n'
			);

			const result = await getServiceStatus();

			expect(['active', 'inactive', 'failed', 'activating', 'deactivating', 'unknown']).toContain(
				result.state
			);
			expect(result.state).toBe('unknown');
			expect(result.mainPid).toBe(42);
		});

		it('handles values containing equals signs (splits on first equals only)', async () => {
			execFileMock.mockResolvedValueOnce(
				'ActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\nMainPID=0\nResult=key=value\n'
			);

			const result = await getServiceStatus();

			expect(result.result).toBe('key=value');
		});
	});
});
