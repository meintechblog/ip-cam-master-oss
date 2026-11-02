import { db } from '$lib/server/db/client';
import { settings } from '$lib/server/db/schema';
import { encrypt, decrypt } from './crypto';
import { eq, like } from 'drizzle-orm';

const SENSITIVE_KEYS = ['proxmox_token_secret', 'unifi_password', 'udm_ssh_password', 'proxmox_ssh_password', 'credential_password'];

// In-memory cache for getSettings() — avoids DB query on every call (30s TTL)
let settingsCache: { data: Record<string, string>; prefix: string; expiresAt: number } | null = null;

function invalidateSettingsCache(): void {
	settingsCache = null;
}

function isSensitive(key: string): boolean {
	return SENSITIVE_KEYS.includes(key);
}

export async function getSetting(key: string): Promise<string | null> {
	const rows = db.select().from(settings).where(eq(settings.key, key)).all();
	if (rows.length === 0) return null;
	const row = rows[0];
	if (row.encrypted) {
		try {
			return decrypt(row.value);
		} catch {
			return null;
		}
	}
	return row.value;
}

export async function getSettings(prefix: string): Promise<Record<string, string>> {
	if (settingsCache && settingsCache.prefix === prefix && Date.now() < settingsCache.expiresAt) {
		return settingsCache.data;
	}

	const rows = db
		.select()
		.from(settings)
		.where(like(settings.key, `${prefix}%`))
		.all();

	const result: Record<string, string> = {};
	for (const row of rows) {
		if (row.encrypted) {
			try {
				result[row.key] = decrypt(row.value);
			} catch {
				result[row.key] = '';
			}
		} else {
			result[row.key] = row.value;
		}
	}
	settingsCache = { data: result, prefix, expiresAt: Date.now() + 30_000 };
	return result;
}

export async function saveSetting(key: string, value: string): Promise<void> {
	invalidateSettingsCache();
	const sensitive = isSensitive(key);
	const storedValue = sensitive ? encrypt(value) : value;

	db.insert(settings)
		.values({
			key,
			value: storedValue,
			encrypted: sensitive,
			updatedAt: new Date().toISOString()
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: {
				value: storedValue,
				encrypted: sensitive,
				updatedAt: new Date().toISOString()
			}
		})
		.run();

	// v1.3 Phase 19 — drop the cached unifi-protect lib client on creds change
	// so the next fetchBootstrap() does not reuse a stale session token (RESEARCH Pitfall 5).
	// Dynamic import is intentional: legacy paths do not reference protect-bridge,
	// and a top-level static import would unnecessarily eager-load it on every settings read.
	if (key.startsWith('unifi_')) {
		const { resetProtectClient } = await import('./protect-bridge');
		resetProtectClient();
	}
}

export async function saveSettings(data: Record<string, string>): Promise<void> {
	invalidateSettingsCache();
	for (const [key, value] of Object.entries(data)) {
		await saveSetting(key, value);
	}
}
