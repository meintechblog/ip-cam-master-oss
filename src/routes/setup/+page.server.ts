import { redirect, fail } from '@sveltejs/kit';
import { getUser, createUser, createSession, isYoloMode, validateSession, setSessionCookie } from '$lib/server/services/auth';
import { saveSetting } from '$lib/server/services/settings';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	const user = getUser();
	if (user) {
		if (isYoloMode()) {
			redirect(303, '/');
		}
		const sessionId = cookies.get('session');
		if (sessionId && validateSession(sessionId)) {
			redirect(303, '/');
		}
		redirect(303, '/login');
	}
	return {};
};

export const actions: Actions = {
	create: async ({ request, cookies }) => {
		const data = await request.formData();
		const username = data.get('username')?.toString().trim() ?? '';
		const password = data.get('password')?.toString() ?? '';
		const confirmPassword = data.get('confirmPassword')?.toString() ?? '';

		if (!username) {
			return fail(400, { error: 'Benutzername ist erforderlich.', username });
		}
		if (password.length < 6) {
			return fail(400, { error: 'Passwort muss mindestens 6 Zeichen lang sein.', username });
		}
		if (password !== confirmPassword) {
			return fail(400, { error: 'Passwörter stimmen nicht überein.', username });
		}

		createUser(username, password);
		const sessionId = createSession(username);
		setSessionCookie(cookies, sessionId);
		redirect(303, '/');
	},

	yolo: async () => {
		await saveSetting('auth_yolo', 'true');
		redirect(303, '/');
	}
};
