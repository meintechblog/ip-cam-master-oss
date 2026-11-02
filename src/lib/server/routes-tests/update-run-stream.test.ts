import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/services/update-runner', () => ({
	tailUpdateLog: vi.fn(async function* () {
		// Infinite no-op generator so the SSE stream stays open until aborted
		await new Promise(() => {});
	})
}));

vi.mock('$lib/server/services/update-history', () => ({
	updateUpdateRun: vi.fn()
}));

import { GET } from '../../../routes/api/update/run/stream/+server';

function buildEvent(search: Record<string, string>) {
	const params = new URLSearchParams(search);
	const url = new URL(`http://localhost/api/update/run/stream?${params}`);
	const request = new Request(url, { method: 'GET' });
	return { url, request } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/update/run/stream path validation', () => {
	it('rejects logPath containing `..` traversal with 400 invalid_path', async () => {
		const res = await GET(
			buildEvent({
				logPath: '/tmp/ip-cam-master-update-1234.log/../../../etc/passwd',
				exitcodeFile: '/tmp/ip-cam-master-update-1234.exitcode'
			})
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: 'invalid_path' });
	});

	it('rejects absolute path outside /tmp/ip-cam-master-update-*', async () => {
		const res = await GET(
			buildEvent({
				logPath: '/etc/passwd',
				exitcodeFile: '/tmp/ip-cam-master-update-1234.exitcode'
			})
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: 'invalid_path' });
	});

	it('rejects logPath with shell metacharacters', async () => {
		const res = await GET(
			buildEvent({
				logPath: '/tmp/ip-cam-master-update-1234.log;rm -rf /',
				exitcodeFile: '/tmp/ip-cam-master-update-1234.exitcode'
			})
		);
		expect(res.status).toBe(400);
	});

	it('rejects logPath with non-numeric timestamp', async () => {
		const res = await GET(
			buildEvent({
				logPath: '/tmp/ip-cam-master-update-abc.log',
				exitcodeFile: '/tmp/ip-cam-master-update-abc.exitcode'
			})
		);
		expect(res.status).toBe(400);
	});

	it('rejects missing logPath', async () => {
		const res = await GET(
			buildEvent({
				exitcodeFile: '/tmp/ip-cam-master-update-1234.exitcode'
			})
		);
		expect(res.status).toBe(400);
	});

	it('rejects exitcodeFile pointing outside the expected glob', async () => {
		const res = await GET(
			buildEvent({
				logPath: '/tmp/ip-cam-master-update-1234.log',
				exitcodeFile: '/tmp/../etc/shadow'
			})
		);
		expect(res.status).toBe(400);
	});

	it('accepts a valid logPath + exitcodeFile pair and returns text/event-stream', async () => {
		const res = await GET(
			buildEvent({
				logPath: '/tmp/ip-cam-master-update-1234.log',
				exitcodeFile: '/tmp/ip-cam-master-update-1234.exitcode'
			})
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(res.headers.get('cache-control')).toContain('no-cache');
		// Cancel the body so the infinite generator does not leak
		await res.body?.cancel();
	});
});
