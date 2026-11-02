import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VersionInfo } from '$lib/server/services/version';

vi.mock('$lib/server/services/version', () => ({
	getCurrentVersion: vi.fn()
}));

vi.mock('$lib/server/services/update-check', () => ({
	getStoredUpdateStatus: vi.fn()
}));

vi.mock('$lib/server/services/update-runner', () => ({
	spawnUpdateRun: vi.fn(),
	getDirtyFiles: vi.fn()
}));

vi.mock('$lib/server/services/update-history', () => ({
	appendUpdateRun: vi.fn()
}));

vi.mock('$lib/server/services/update-checker', () => ({
	getActiveFlowConflicts: vi.fn(() => [])
}));

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(async () => Buffer.from('schema content'))
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		existsSync: vi.fn(() => true)
	};
});

import { getCurrentVersion } from '$lib/server/services/version';
import { getStoredUpdateStatus } from '$lib/server/services/update-check';
import { spawnUpdateRun, getDirtyFiles } from '$lib/server/services/update-runner';
import { appendUpdateRun } from '$lib/server/services/update-history';
import { getActiveFlowConflicts } from '$lib/server/services/update-checker';
import { POST } from '../../../routes/api/update/run/+server';

const CLEAN_SHA = 'a'.repeat(40);
const LATEST_SHA = 'b'.repeat(40);

function makeVersion(overrides: Partial<VersionInfo> = {}): VersionInfo {
	return {
		version: `main @ ${CLEAN_SHA.slice(0, 7)}`,
		sha: CLEAN_SHA,
		tag: null,
		isDev: false,
		isDirty: false,
		...overrides
	};
}

function buildEvent(body: unknown = {}, host = '127.0.0.1') {
	const request = new Request('http://localhost/api/update/run', {
		method: 'POST',
		headers: { 'content-type': 'application/json', host },
		body: JSON.stringify(body)
	});
	return { request } as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/update/run', () => {
	beforeEach(() => {
		vi.mocked(getCurrentVersion).mockReset();
		vi.mocked(getStoredUpdateStatus).mockReset();
		vi.mocked(spawnUpdateRun).mockReset();
		vi.mocked(getDirtyFiles).mockReset();
		vi.mocked(appendUpdateRun).mockReset();
		vi.mocked(appendUpdateRun).mockResolvedValue(0);
		vi.mocked(getActiveFlowConflicts).mockReset();
		vi.mocked(getActiveFlowConflicts).mockReturnValue([]);
	});

	it('returns 403 when Host header is non-localhost (UPD-AUTO-12)', async () => {
		const res = await POST(buildEvent({}, '192.168.1.10'));
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body).toEqual({ error: 'localhost_only' });
	});

	it('returns 400 dev_mode when getCurrentVersion().isDev', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion({ isDev: true }));
		const res = await POST(buildEvent());
		expect(res.status).toBe(400);
		expect(spawnUpdateRun).not.toHaveBeenCalled();
	});

	it('returns 409 dirty_tree with dirtyFiles when isDirty', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion({ isDirty: true }));
		vi.mocked(getDirtyFiles).mockResolvedValue(['M src/foo.ts', '?? data/new.db']);
		const res = await POST(buildEvent());
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body).toEqual({ error: 'dirty_tree', dirtyFiles: ['M src/foo.ts', '?? data/new.db'] });
	});

	it('returns 400 already_up_to_date when !hasUpdate and !force', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(getStoredUpdateStatus).mockResolvedValue({
			lastCheckedAt: null,
			latestSha: CLEAN_SHA,
			latestCommitDate: null,
			latestCommitMessage: null,
			lastError: null,
			current: makeVersion(),
			hasUpdate: false
		});
		const res = await POST(buildEvent());
		expect(res.status).toBe(400);
	});

	it('returns 409 active_flows when conflicts exist and ignoreConflicts is false', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(getStoredUpdateStatus).mockResolvedValue({
			lastCheckedAt: null,
			latestSha: LATEST_SHA,
			latestCommitDate: null,
			latestCommitMessage: null,
			lastError: null,
			current: makeVersion(),
			hasUpdate: true
		});
		vi.mocked(getActiveFlowConflicts).mockReturnValue([
			{ kind: 'hub_starting', detail: 'bridge starting' }
		]);
		const res = await POST(buildEvent());
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toBe('active_flows');
	});

	it('happy path returns 202 and writes update_runs row with target+trigger', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(getStoredUpdateStatus).mockResolvedValue({
			lastCheckedAt: null,
			latestSha: LATEST_SHA,
			latestCommitDate: null,
			latestCommitMessage: null,
			lastError: null,
			current: makeVersion(),
			hasUpdate: true
		});
		vi.mocked(spawnUpdateRun).mockResolvedValue({
			logPath: '/tmp/ip-cam-master-update-9999.log',
			exitcodeFile: '/tmp/ip-cam-master-update-9999.exitcode',
			unitName: 'ip-cam-master-update-9999',
			startedAt: '2026-04-10T13:00:00.000Z',
			backupPath: '/opt/ip-cam-master/data/backups/x.db',
			targetSha: LATEST_SHA
		});

		const res = await POST(buildEvent());
		expect(res.status).toBe(202);

		expect(spawnUpdateRun).toHaveBeenCalledOnce();
		const opts = vi.mocked(spawnUpdateRun).mock.calls[0][0];
		expect(opts.preSha).toBe(CLEAN_SHA);
		expect(opts.preSchemaHash).toMatch(/^[0-9a-f]{64}$/);
		expect(opts.targetSha).toBe(LATEST_SHA);
		expect(opts.trigger).toBe('manual');

		expect(appendUpdateRun).toHaveBeenCalledOnce();
		expect(appendUpdateRun).toHaveBeenCalledWith(
			expect.objectContaining({
				preSha: CLEAN_SHA,
				targetSha: LATEST_SHA,
				trigger: 'manual',
				result: 'running'
			})
		);
	});
});
