import { json } from '@sveltejs/kit';
import { getStoredUpdateStatus } from '$lib/server/services/update-check';
import { formatVersionLabel } from '$lib/server/services/version';
import { getStateSnapshot } from '$lib/server/services/update-state-store';
import { deriveUpdateInfoView } from '$lib/server/services/update-info-view';
import { getSettings } from '$lib/server/services/settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const status = await getStoredUpdateStatus();
	const { state, currentSha, currentShaShort } = getStateSnapshot();
	const view = deriveUpdateInfoView(state, currentSha, currentShaShort);
	const updateSettings = await getSettings('update.');

	return json(
		{
			current: {
				label: formatVersionLabel(status.current),
				sha: status.current.sha,
				tag: status.current.tag,
				isDev: status.current.isDev,
				isDirty: status.current.isDirty
			},
			lastCheckedAt: status.lastCheckedAt,
			latestSha: status.latestSha,
			latestCommitDate: status.latestCommitDate,
			latestCommitMessage: status.latestCommitMessage,
			lastError: status.lastError,
			hasUpdate: status.hasUpdate,
			// New in Phase 24:
			updateStatus: view.updateStatus,
			rollbackHappened: view.rollbackHappened,
			rollbackReason: view.rollbackReason,
			rollbackStage: view.rollbackStage,
			inProgressUpdate: view.inProgressUpdate,
			autoUpdate: {
				enabled: updateSettings['update.autoUpdate'] === 'true',
				hour: Number.parseInt(updateSettings['update.autoUpdateHour'] ?? '3', 10),
				lastAutoUpdateAt: updateSettings['update.lastAutoUpdateAt']
					? new Date(Number.parseInt(updateSettings['update.lastAutoUpdateAt'], 10)).toISOString()
					: null
			}
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
