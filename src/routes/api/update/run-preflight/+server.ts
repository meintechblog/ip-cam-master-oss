/**
 * GET /api/update/run-preflight
 *
 * Returns a list of active-flow conflicts the user should be warned
 * about before triggering a manual update. Used by the install
 * confirmation modal (UPD-AUTO-06).
 *
 * Conflicts include: Hub bridge starting/stopping (v1.3 Protect Hub),
 * in-flight onboarding wizard, etc. Empty array = clear to install.
 */

import { json } from '@sveltejs/kit';
import { getActiveFlowConflicts } from '$lib/server/services/update-checker';
import { getCurrentVersion } from '$lib/server/services/version';
import { getStoredUpdateStatus } from '$lib/server/services/update-check';
import { getDirtyFiles } from '$lib/server/services/update-runner';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const current = await getCurrentVersion();
	const status = await getStoredUpdateStatus();
	const conflicts = getActiveFlowConflicts();
	const dirtyFiles = current.isDirty ? await getDirtyFiles() : [];

	return json({
		current: {
			sha: current.sha,
			shaShort: current.sha?.slice(0, 7) ?? 'unknown',
			isDev: current.isDev,
			isDirty: current.isDirty
		},
		target: {
			sha: status.latestSha,
			shaShort: status.latestSha?.slice(0, 7) ?? null,
			message: status.latestCommitMessage,
			date: status.latestCommitDate
		},
		hasUpdate: status.hasUpdate,
		dirtyFiles,
		conflicts
	});
};
