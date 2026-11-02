import { redirect } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/services/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	const sessionId = cookies.get('session');
	if (sessionId) {
		deleteSession(sessionId);
	}
	cookies.delete('session', { path: '/' });
	redirect(303, '/login');
};
