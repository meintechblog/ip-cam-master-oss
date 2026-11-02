/**
 * Pure derive function: state.json + current-version → UI view model.
 *
 * The view model is what `/api/update/status` returns and what the
 * Settings UI renders. Keeping the derivation in a pure function makes
 * it cheaply testable and lets the SSR `/settings` page render without
 * round-tripping through the API.
 */

import type { LastCheckResult, UpdateState, UpdateStatus } from './update-state-store';

export type UpdateInfoView = {
	currentSha: string;
	currentShaShort: string;
	buildTime: string | null;
	updateStatus: UpdateStatus;
	updateAvailable: boolean;
	lastCheckAt: string | null;
	lastCheckStatus: 'ok' | 'unchanged' | 'rate_limited' | 'error' | null;
	remote: {
		sha: string;
		shaShort: string;
		message: string;
		author: string;
		date: string;
	} | null;
	error: string | null;
	rateLimitResetAt: number | null;
	rollbackHappened: boolean;
	rollbackReason: string | null;
	rollbackStage: 'stage1' | 'stage2' | null;
	inProgressUpdate: { targetSha: string | null; startedAt: string | null } | null;
};

export function deriveUpdateInfoView(
	state: UpdateState,
	currentSha: string,
	currentShaShort: string,
	buildTime: string | null = null
): UpdateInfoView {
	const last = state.lastCheckResult;
	const lastCheckStatus = last?.status ?? null;

	let remote: UpdateInfoView['remote'] = null;
	let error: string | null = null;
	let rateLimitResetAt: number | null = null;

	if (last) {
		switch (last.status) {
			case 'ok':
				remote = {
					sha: last.remoteSha,
					shaShort: last.remoteShaShort,
					message: last.message,
					author: last.author,
					date: last.date
				};
				break;
			case 'unchanged':
				// 304 from GitHub — keep no remote info; UI shows "up to date"
				break;
			case 'rate_limited':
				rateLimitResetAt = last.resetAt;
				break;
			case 'error':
				error = last.error;
				break;
		}
	}

	const updateAvailable = !!remote && remote.sha !== currentSha;

	const inProgressUpdate =
		state.updateStatus === 'installing'
			? { targetSha: state.targetSha, startedAt: state.updateStartedAt }
			: null;

	return {
		currentSha,
		currentShaShort,
		buildTime,
		updateStatus: state.updateStatus,
		updateAvailable,
		lastCheckAt: state.lastCheckAt,
		lastCheckStatus: lastCheckStatus as UpdateInfoView['lastCheckStatus'],
		remote,
		error,
		rateLimitResetAt,
		rollbackHappened: state.rollbackHappened,
		rollbackReason: state.rollbackReason,
		rollbackStage: state.rollbackStage,
		inProgressUpdate
	};
}

export type { LastCheckResult } from './update-state-store';
