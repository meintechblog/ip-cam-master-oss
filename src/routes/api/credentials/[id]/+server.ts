import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { credentials } from '$lib/server/db/schema';
import { decrypt } from '$lib/server/services/crypto';
import { eq } from 'drizzle-orm';

/**
 * Return a single credential with its decrypted secret.
 *
 * Mobotix rows expose `{ username, password }`; Bambu rows expose
 * `{ serialNumber, accessCode }`. Callers are session-authenticated
 * (hooks.server.ts enforces it) and use this only to pre-fill the
 * onboarding wizard when a user picks a saved login from a dropdown.
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = parseInt(params.id);
	if (!Number.isFinite(id)) return json({ error: 'Ungültige ID' }, { status: 400 });

	const row = db.select().from(credentials).where(eq(credentials.id, id)).get();
	if (!row) return json({ error: 'Credential nicht gefunden' }, { status: 404 });

	const type = (row.type || 'mobotix') as 'mobotix' | 'bambu';

	try {
		if (type === 'bambu') {
			const accessCode = row.accessCode ? decrypt(row.accessCode) : '';
			return json({
				id: row.id,
				name: row.name,
				type: 'bambu',
				serialNumber: row.serialNumber ?? '',
				accessCode
			});
		}
		return json({
			id: row.id,
			name: row.name,
			type: 'mobotix',
			username: row.username,
			password: decrypt(row.password)
		});
	} catch (err) {
		return json(
			{ error: `Entschlüsselung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 }
		);
	}
};
