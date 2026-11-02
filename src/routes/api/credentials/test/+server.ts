import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { credentials } from '$lib/server/db/schema';
import { decrypt } from '$lib/server/services/crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Try saved credentials against a camera IP.
 * Accepts optional `cameraType` hint to prioritize matching credentials.
 * Credentials whose name contains the camera type keyword are tried first,
 * reducing failed auth attempts that can lock out devices (e.g. Loxone Intercom).
 */
export const POST: RequestHandler = async ({ request }) => {
	const { ip, cameraType } = await request.json();
	if (!ip) return json({ success: false, error: 'IP erforderlich' }, { status: 400 });

	const allRows = db.select().from(credentials).all() as any[];

	// Sort: matching type first (by name keyword), then by priority
	const rows = allRows.sort((a, b) => {
		const aMatch = typeMatchScore(a.name, cameraType);
		const bMatch = typeMatchScore(b.name, cameraType);
		if (aMatch !== bMatch) return bMatch - aMatch; // higher score first
		return a.priority - b.priority;
	});

	// Pick endpoints based on camera type hint — avoids unnecessary requests
	let endpoints: string[];
	if (cameraType === 'loxone') {
		endpoints = ['/mjpg/video.mjpg'];
	} else if (cameraType === 'mobotix' || cameraType === 'mobotix-onvif') {
		endpoints = ['/record/current.jpg'];
	} else {
		endpoints = ['/record/current.jpg', '/mjpg/video.mjpg'];
	}

	for (const row of rows) {
		try {
			const password = decrypt(row.password);
			for (const endpoint of endpoints) {
				try {
					// MJPEG streams never complete — use longer max-time to allow slow devices
					// (Loxone Intercom can take 5-8s to return HTTP headers)
					const isMjpeg = endpoint.includes('mjpg');
					const connectTimeout = isMjpeg ? 5 : 3;
					const maxTime = isMjpeg ? 10 : 3;
					let stdout = '';
					try {
						const result = await execAsync(
							`curl -s --basic -u "${row.username}:${password}" "http://${ip}${endpoint}" --connect-timeout ${connectTimeout} --max-time ${maxTime} -o /dev/null -w "%{http_code}"`,
							{ timeout: (maxTime + 5) * 1000, encoding: 'utf-8' }
						);
						stdout = result.stdout;
					} catch (e: unknown) {
						// curl exits 28 on timeout for streaming — check stdout anyway
						stdout = (e as any)?.stdout || '';
					}
					const code = stdout.trim();
					if (code === '200' || code === '206') {
						return json({
							success: true,
							credentialId: row.id,
							name: row.name,
							username: row.username,
							password
						});
					}
				} catch { /* try next endpoint */ }
			}
		} catch {
			// Decryption failed, try next credential
		}
	}

	// Live test failed — fallback: return best matching credential by type without testing
	// This handles lockout situations where the camera blocks auth attempts
	if (cameraType) {
		const bestMatch = rows.find(r => typeMatchScore(r.name, cameraType) > 0);
		if (bestMatch) {
			try {
				const password = decrypt(bestMatch.password);
				return json({
					success: true,
					credentialId: bestMatch.id,
					name: bestMatch.name,
					username: bestMatch.username,
					password,
					untested: true
				});
			} catch { /* decryption failed */ }
		}
	}

	return json({ success: false, message: 'Kein gespeichertes Login hat funktioniert' });
};

/** Score how well a credential name matches a camera type (higher = better match) */
function typeMatchScore(credentialName: string, cameraType?: string): number {
	if (!cameraType) return 0;
	const name = credentialName.toLowerCase();
	const type = cameraType.toLowerCase();

	// Direct keyword match
	if (type.includes('loxone') && name.includes('loxone')) return 2;
	if (type.includes('mobotix') && name.includes('mobotix')) return 2;

	// Inverse penalty: wrong type in name
	if (type.includes('loxone') && name.includes('mobotix')) return -1;
	if (type.includes('mobotix') && name.includes('loxone')) return -1;

	return 0;
}
