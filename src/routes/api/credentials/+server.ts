import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { credentials } from '$lib/server/db/schema';
import { encrypt, decrypt } from '$lib/server/services/crypto';
import { eq } from 'drizzle-orm';

type CredType = 'mobotix' | 'bambu';

export const GET: RequestHandler = async () => {
	const rows = db.select().from(credentials).all() as Array<{
		id: number; name: string; type: string;
		username: string; password: string;
		accessCode: string | null; serialNumber: string | null;
		priority: number;
	}>;
	const result = rows
		.sort((a, b) => a.priority - b.priority)
		.map((r) => {
			const type = (r.type || 'mobotix') as CredType;
			if (type === 'bambu') {
				let pwLen = 8;
				try { pwLen = r.accessCode ? decrypt(r.accessCode).length : 8; } catch { /* keep default */ }
				return {
					id: r.id,
					name: r.name,
					type: 'bambu' as const,
					serialNumber: r.serialNumber ?? '',
					accessCodeMasked: '*'.repeat(Math.min(pwLen, 12)),
					priority: r.priority
				};
			}
			let pwLen = 0;
			try { pwLen = decrypt(r.password).length; } catch { pwLen = 3; }
			return {
				id: r.id,
				name: r.name,
				type: 'mobotix' as const,
				username: r.username,
				passwordMasked: '*'.repeat(Math.min(pwLen, 12)),
				priority: r.priority
			};
		});
	return json(result);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const type: CredType = body.type === 'bambu' ? 'bambu' : 'mobotix';

	if (!body.name) {
		return json({ success: false, error: 'Name erforderlich' }, { status: 400 });
	}

	if (type === 'bambu') {
		const { serialNumber, accessCode } = body;
		// Serial is optional: a cred without a serial serves as a fallback
		// for any discovered Bambu that has no exact-serial match. Helpful
		// when the user knows one shared access code but hasn't memorised
		// each printer's serial.
		if (!accessCode) {
			return json({ success: false, error: 'Access Code erforderlich' }, { status: 400 });
		}
		if (typeof accessCode !== 'string' || accessCode.length !== 8) {
			return json({ success: false, error: 'Access Code muss 8 Zeichen lang sein' }, { status: 400 });
		}
		const serial = typeof serialNumber === 'string' && serialNumber.trim().length > 0
			? serialNumber.trim()
			: null;
		const maxPriority = (db.select().from(credentials).all() as unknown[]).length;
		db.insert(credentials)
			.values({
				name: body.name,
				type: 'bambu',
				// Bambu rows reuse the existing NOT NULL columns: 'bblp' as the
				// canonical Bambu RTSP username, encrypted access code duplicated
				// into `password` so legacy readers that ignore `type` still see
				// a plausible value. Canonical fields are serial_number/access_code.
				username: 'bblp',
				password: encrypt(accessCode),
				serialNumber: serial,
				accessCode: encrypt(accessCode),
				priority: maxPriority
			})
			.run();
		return json({ success: true });
	}

	const { username, password } = body;
	if (!username || !password) {
		return json({ success: false, error: 'Benutzername und Passwort erforderlich' }, { status: 400 });
	}

	const maxPriority = (db.select().from(credentials).all() as unknown[]).length;
	db.insert(credentials)
		.values({
			name: body.name,
			type: 'mobotix',
			username,
			password: encrypt(password),
			priority: maxPriority
		})
		.run();
	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const { id } = await request.json();
	if (!id) return json({ success: false, error: 'ID erforderlich' }, { status: 400 });

	db.delete(credentials).where(eq(credentials.id, id)).run();
	return json({ success: true });
};
