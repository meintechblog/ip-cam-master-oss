/**
 * Self-update check — wraps github-client and persists results to
 * state.json (UPD-AUTO-03 ETag, UPD-AUTO-11 cooldown).
 *
 * Public API (preserved for backwards compatibility with existing
 * routes and the settings UI):
 *   - checkForUpdate(): UpdateCheckResult
 *   - getStoredUpdateStatus(): StoredUpdateStatus
 *
 * Behavior changes vs v1.1:
 *   - Sends If-None-Match using state.lastCheckEtag
 *   - On 304, preserves the prior `ok` result (only updates lastCheckAt)
 *   - 5-min server-side cooldown for manual checks
 *   - Persists to state.json (atomic) instead of N settings rows
 */

import { getCurrentVersion, type VersionInfo } from './version';
import { checkLatestCommit } from './github-client';
import {
	readUpdateState,
	writeUpdateState,
	isCheckCooldownClear
} from './update-state-store';

export type UpdateCheckSuccess = {
	error: null;
	current: VersionInfo;
	latestSha: string;
	latestCommitDate: string;
	latestCommitMessage: string;
	hasUpdate: boolean;
	warning: 'dirty' | null;
	checkedAt: string;
};

export type UpdateCheckCooldown = { error: 'cooldown'; retryAfterSeconds: number };
export type UpdateCheckRateLimited = { error: 'rate_limited'; resetAt: string };
export type UpdateCheckNetwork = { error: 'network'; message: string };
export type UpdateCheckDevMode = { error: 'dev_mode' };

export type UpdateCheckResult =
	| UpdateCheckSuccess
	| UpdateCheckCooldown
	| UpdateCheckRateLimited
	| UpdateCheckNetwork
	| UpdateCheckDevMode;

export type StoredUpdateStatus = {
	lastCheckedAt: string | null;
	latestSha: string | null;
	latestCommitDate: string | null;
	latestCommitMessage: string | null;
	lastError: string | null;
	current: VersionInfo;
	hasUpdate: boolean;
};

export type CheckForUpdateOptions = {
	/**
	 * Manual user-triggered check enforces the 5-min cooldown
	 * (UPD-AUTO-11). The scheduler tick passes false to bypass.
	 */
	enforceCooldown?: boolean;
};

/**
 * Live-check GitHub for the latest commit on main and persist the
 * result. Never throws — returns a discriminated union.
 */
export async function checkForUpdate(
	options: CheckForUpdateOptions = {}
): Promise<UpdateCheckResult> {
	const { enforceCooldown = false } = options;
	const current = await getCurrentVersion();
	if (current.isDev) {
		return { error: 'dev_mode' };
	}

	if (enforceCooldown) {
		const cd = isCheckCooldownClear();
		if (!cd.clear) {
			return { error: 'cooldown', retryAfterSeconds: cd.retryAfterSeconds };
		}
	}

	const state = readUpdateState();
	const { result, etag } = await checkLatestCommit({ etag: state.lastCheckEtag });

	const checkedAt = new Date().toISOString();

	switch (result.status) {
		case 'ok': {
			writeUpdateState({
				lastCheckAt: checkedAt,
				lastCheckEtag: etag ?? state.lastCheckEtag,
				lastCheckResult: result
			});
			const hasUpdate = current.sha !== result.remoteSha && !current.isDirty;
			return {
				error: null,
				current,
				latestSha: result.remoteSha,
				latestCommitDate: result.date,
				latestCommitMessage: result.message,
				hasUpdate,
				warning: current.isDirty ? 'dirty' : null,
				checkedAt
			};
		}
		case 'unchanged': {
			// 304 — preserve the prior `ok` result (or absence thereof) and
			// only stamp lastCheckAt. The view-model derivation reads the
			// preserved result for display.
			writeUpdateState({ lastCheckAt: checkedAt });
			const prior = state.lastCheckResult;
			if (prior?.status === 'ok') {
				const hasUpdate = current.sha !== prior.remoteSha && !current.isDirty;
				return {
					error: null,
					current,
					latestSha: prior.remoteSha,
					latestCommitDate: prior.date,
					latestCommitMessage: prior.message,
					hasUpdate,
					warning: current.isDirty ? 'dirty' : null,
					checkedAt
				};
			}
			// No prior ok — treat as success but with empty latest fields
			return {
				error: null,
				current,
				latestSha: current.sha,
				latestCommitDate: '',
				latestCommitMessage: '',
				hasUpdate: false,
				warning: current.isDirty ? 'dirty' : null,
				checkedAt
			};
		}
		case 'rate_limited': {
			writeUpdateState({
				lastCheckAt: checkedAt,
				lastCheckResult: result
			});
			const resetAt = new Date(result.resetAt * 1000).toISOString();
			return { error: 'rate_limited', resetAt };
		}
		case 'error': {
			writeUpdateState({
				lastCheckAt: checkedAt,
				lastCheckResult: result
			});
			return { error: 'network', message: result.error };
		}
	}
}

/**
 * Read persisted state from state.json and compose with current version
 * for display. Used by the cached `/api/update/status` endpoint.
 */
export async function getStoredUpdateStatus(): Promise<StoredUpdateStatus> {
	const [current, state] = [await getCurrentVersion(), readUpdateState()];
	const last = state.lastCheckResult;

	let latestSha: string | null = null;
	let latestCommitDate: string | null = null;
	let latestCommitMessage: string | null = null;
	let lastError: string | null = null;

	if (last?.status === 'ok') {
		latestSha = last.remoteSha;
		latestCommitDate = last.date || null;
		latestCommitMessage = last.message || null;
	} else if (last?.status === 'rate_limited') {
		const resetAt = new Date(last.resetAt * 1000).toISOString();
		lastError = `rate_limited:${resetAt}`;
	} else if (last?.status === 'error') {
		lastError = 'network';
	}

	const hasUpdate = !!latestSha && latestSha !== current.sha && !current.isDirty;

	return {
		lastCheckedAt: state.lastCheckAt,
		latestSha,
		latestCommitDate,
		latestCommitMessage,
		lastError,
		current,
		hasUpdate
	};
}
