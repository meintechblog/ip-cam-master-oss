import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VersionInfo } from './version';
import type { LastCheckResult } from './update-state-store';

vi.mock('./version', () => ({
	getCurrentVersion: vi.fn()
}));

const stateStore: { state: Record<string, unknown> } = { state: {} };

vi.mock('./update-state-store', () => ({
	readUpdateState: vi.fn(() => ({
		currentSha: 'a'.repeat(40),
		rollbackSha: null,
		lastCheckAt: stateStore.state.lastCheckAt ?? null,
		lastCheckEtag: stateStore.state.lastCheckEtag ?? null,
		lastCheckResult: stateStore.state.lastCheckResult ?? null,
		updateStatus: 'idle',
		targetSha: null,
		updateStartedAt: null,
		rollbackHappened: false,
		rollbackReason: null,
		rollbackStage: null
	})),
	writeUpdateState: vi.fn((patch: Record<string, unknown>) => {
		Object.assign(stateStore.state, patch);
		return { ...stateStore.state };
	}),
	isCheckCooldownClear: vi.fn(() => ({ clear: true, retryAfterSeconds: 0 }))
}));

vi.mock('./github-client', () => ({
	checkLatestCommit: vi.fn()
}));

import { getCurrentVersion } from './version';
import { checkLatestCommit } from './github-client';
import { isCheckCooldownClear } from './update-state-store';
import { checkForUpdate } from './update-check';

const CURRENT_SHA = 'a'.repeat(40);
const LATEST_SHA = 'b'.repeat(40);

function makeVersion(overrides: Partial<VersionInfo> = {}): VersionInfo {
	return {
		version: `main @ ${CURRENT_SHA.slice(0, 7)}`,
		sha: CURRENT_SHA,
		tag: null,
		isDev: false,
		isDirty: false,
		...overrides
	};
}

describe('checkForUpdate (state.json + ETag)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		stateStore.state = {};
	});

	it('returns dev_mode when running outside git', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion({ isDev: true, sha: 'unknown' }));
		const result = await checkForUpdate();
		expect(result).toEqual({ error: 'dev_mode' });
		expect(checkLatestCommit).not.toHaveBeenCalled();
	});

	it('returns success with hasUpdate=true when remote SHA differs', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(checkLatestCommit).mockResolvedValue({
			result: {
				status: 'ok',
				remoteSha: LATEST_SHA,
				remoteShaShort: LATEST_SHA.slice(0, 7),
				message: 'feat: new thing',
				author: 'tester',
				date: '2026-04-10T12:00:00Z'
			} as LastCheckResult,
			etag: 'W/"abc"'
		});

		const result = await checkForUpdate();
		expect(result).toMatchObject({
			error: null,
			latestSha: LATEST_SHA,
			latestCommitMessage: 'feat: new thing',
			hasUpdate: true,
			warning: null
		});
	});

	it('passes If-None-Match etag when present in state', async () => {
		stateStore.state.lastCheckEtag = 'W/"prev-etag"';
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(checkLatestCommit).mockResolvedValue({
			result: { status: 'unchanged' },
			etag: null
		});
		await checkForUpdate();
		expect(checkLatestCommit).toHaveBeenCalledWith({ etag: 'W/"prev-etag"' });
	});

	it('handles 304 unchanged by preserving prior ok result', async () => {
		stateStore.state.lastCheckResult = {
			status: 'ok',
			remoteSha: LATEST_SHA,
			remoteShaShort: LATEST_SHA.slice(0, 7),
			message: 'previous commit',
			author: 'tester',
			date: '2026-04-09T12:00:00Z'
		} as LastCheckResult;
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(checkLatestCommit).mockResolvedValue({
			result: { status: 'unchanged' },
			etag: null
		});

		const result = await checkForUpdate();
		expect(result).toMatchObject({
			error: null,
			latestSha: LATEST_SHA,
			latestCommitMessage: 'previous commit',
			hasUpdate: true
		});
	});

	it('returns rate_limited with reset ISO when 403/x-ratelimit-remaining=0', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		const resetUnix = Math.floor(Date.now() / 1000) + 600;
		vi.mocked(checkLatestCommit).mockResolvedValue({
			result: { status: 'rate_limited', resetAt: resetUnix } as LastCheckResult,
			etag: null
		});
		const result = await checkForUpdate();
		expect(result).toMatchObject({ error: 'rate_limited' });
	});

	it('returns network on github-client error', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(checkLatestCommit).mockResolvedValue({
			result: { status: 'error', error: 'timed out after 10000ms' },
			etag: null
		});
		const result = await checkForUpdate();
		expect(result).toMatchObject({ error: 'network', message: 'timed out after 10000ms' });
	});

	it('returns cooldown when enforceCooldown=true and cooldown not clear', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(isCheckCooldownClear).mockReturnValue({ clear: false, retryAfterSeconds: 42 });
		const result = await checkForUpdate({ enforceCooldown: true });
		expect(result).toEqual({ error: 'cooldown', retryAfterSeconds: 42 });
		expect(checkLatestCommit).not.toHaveBeenCalled();
	});

	it('skips cooldown check when enforceCooldown=false (scheduler path)', async () => {
		vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion());
		vi.mocked(checkLatestCommit).mockResolvedValue({
			result: { status: 'unchanged' },
			etag: null
		});
		await checkForUpdate({ enforceCooldown: false });
		expect(isCheckCooldownClear).not.toHaveBeenCalled();
	});
});
