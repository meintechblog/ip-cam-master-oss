import { redirect, fail } from '@sveltejs/kit';
import { getUser, verifyPassword, createSession, isYoloMode, validateSession, setSessionCookie } from '$lib/server/services/auth';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	if (isYoloMode()) {
		redirect(303, '/');
	}

	const user = getUser();
	if (!user) {
		redirect(303, '/setup');
	}

	const sessionId = cookies.get('session');
	if (sessionId && validateSession(sessionId)) {
		redirect(303, '/');
	}

	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const username = data.get('username')?.toString().trim() ?? '';
		const password = data.get('password')?.toString() ?? '';

		if (!username || !password) {
			return fail(400, { error: 'Benutzername und Passwort sind erforderlich.', username });
		}

		const user = getUser();
		if (!user || user.username !== username || !verifyPassword(password, user.passwordHash)) {
			return fail(400, { error: 'Benutzername oder Passwort falsch.', username });
		}

		const sessionId = createSession(username);
		setSessionCookie(cookies, sessionId);
		redirect(303, '/');
	}
};
