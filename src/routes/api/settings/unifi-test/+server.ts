import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** POST — test UniFi Protect API connectivity with provided credentials */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const { host, username, password } = await request.json();
		if (!host || !username || !password) {
			return json({ success: false, error: 'Host, Username und Password erforderlich.' }, { status: 400 });
		}

		// UniFi OS login to get a session cookie
		const loginRes = await fetch(`https://${host}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password }),
			signal: AbortSignal.timeout(10000)
		});

		if (!loginRes.ok) {
			if (loginRes.status === 401) {
				return json({ success: false, error: 'Login fehlgeschlagen — Username oder Password falsch.' });
			}
			return json({ success: false, error: `UniFi OS antwortet mit HTTP ${loginRes.status}` });
		}

		// Extract session cookie
		const cookies = loginRes.headers.getSetCookie?.() || [];
		const tokenCookie = cookies.find(c => c.startsWith('TOKEN='));
		if (!tokenCookie) {
			return json({ success: false, error: 'Login erfolgreich, aber kein Session-Token erhalten.' });
		}

		// Test Protect API access
		const protectRes = await fetch(`https://${host}/proxy/protect/api/bootstrap`, {
			headers: { Cookie: tokenCookie.split(';')[0] },
			signal: AbortSignal.timeout(10000)
		});

		if (protectRes.ok) {
			const data = await protectRes.json();
			const name = data?.nvr?.name || 'UniFi Protect';
			return json({ success: true, name });
		}

		return json({ success: false, error: `Protect API antwortet mit HTTP ${protectRes.status}` });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
			return json({ success: false, error: `Host nicht erreichbar: ${message}` });
		}
		if (message.includes('self-signed') || message.includes('certificate')) {
			return json({ success: false, error: `SSL-Zertifikatsfehler — ist der Host korrekt?` });
		}
		return json({ success: false, error: message });
	}
};
