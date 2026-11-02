import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { getSettings, getSetting, saveSetting } from '$lib/server/services/settings';
import { getUser, createUser, deleteUser, verifyPassword, isYoloMode } from '$lib/server/services/auth';
import { loadCatalog } from '$lib/server/orchestration/protect-hub/catalog';
import { getBridgeStatus } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';
import { getHubState } from '$lib/server/orchestration/protect-hub/hub-state';

export const load: PageServerLoad = async () => {
	const proxmox = await getSettings('proxmox_');
	const unifi = await getSettings('unifi_');
	const udmSshKeyPath = await getSetting('udm_ssh_key_path');
	const udmSshPassword = await getSetting('udm_ssh_password');
	const user = getUser();

	// v1.3 Phase 19 — Protect Hub tab data block
	const hubEnabled = (await getSetting('protect_hub_enabled')) === 'true';
	const credsConfigured = !!(unifi.unifi_host && unifi.unifi_username && unifi.unifi_password);
	const catalogState = await loadCatalog();
	const bridge = getBridgeStatus();

	// v1.3 Phase 22 Plan 05 — derived hub_state for L-18 toggle-flap-protection (SC-4).
	// ProtectHubTab disables the "Protect Hub aktivieren" toggle when this is
	// 'starting' or 'stopping' and shows an inline spinner + Abbrechen button.
	const hubState = await getHubState();

	return {
		proxmox,
		unifi,
		udmSshKeyPath: udmSshKeyPath ?? '/opt/ip-cam-master/data/udm_key',
		// Prefill the SSH root-password input so the user sees "✓ saved" (as bullets)
		// just like the UDM Host password field a few rows above.
		udmSshPassword: udmSshPassword ?? '',
		hasUser: user !== null,
		authUsername: user?.username ?? null,
		isYolo: isYoloMode(),
		hubState,
		protectHub: {
			enabled: hubEnabled,
			credsConfigured,
			cams: catalogState.cams,
			catalogByCamId: catalogState.catalogByCamId,
			lastDiscoveredAt: catalogState.lastDiscoveredAt,
			bridge: bridge
				? {
						id: bridge.id,
						vmid: bridge.vmid,
						hostname: bridge.hostname,
						containerIp: bridge.containerIp,
						status: bridge.status,
						lastHealthCheckAt: bridge.lastHealthCheckAt
					}
				: null
		}
	};
};

export const actions: Actions = {
	changePassword: async ({ request }) => {
		const data = await request.formData();
		const currentPassword = data.get('currentPassword')?.toString() ?? '';
		const newPassword = data.get('newPassword')?.toString() ?? '';

		if (!currentPassword || !newPassword) {
			return fail(400, { authError: 'Alle Felder sind erforderlich.', authAction: 'changePassword' });
		}
		if (newPassword.length < 6) {
			return fail(400, { authError: 'Neues Passwort muss mindestens 6 Zeichen lang sein.', authAction: 'changePassword' });
		}

		const user = getUser();
		if (!user) {
			return fail(400, { authError: 'Kein Benutzer vorhanden.', authAction: 'changePassword' });
		}
		if (!verifyPassword(currentPassword, user.passwordHash)) {
			return fail(400, { authError: 'Aktuelles Passwort ist falsch.', authAction: 'changePassword' });
		}

		createUser(user.username, newPassword);
		return { authSuccess: 'Passwort wurde geaendert.', authAction: 'changePassword' };
	},

	deleteAuth: async ({ cookies }) => {
		deleteUser();
		await saveSetting('auth_yolo', 'false');
		cookies.delete('session', { path: '/' });
		redirect(303, '/setup');
	},

	toggleYolo: async () => {
		const currentYolo = isYoloMode();
		await saveSetting('auth_yolo', currentYolo ? 'false' : 'true');
		return { authSuccess: currentYolo ? 'YOLO-Modus deaktiviert.' : 'YOLO-Modus aktiviert.', authAction: 'toggleYolo' };
	}
};
