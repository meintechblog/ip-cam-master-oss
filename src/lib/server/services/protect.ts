import { getSettings } from './settings';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import type { ProtectCamera, ProtectCameraMatch, ProtectStatus } from '$lib/types';

// Self-signed UDM certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

interface ProtectSession {
	cookies: string;
	csrfToken: string;
	expiresAt: number;
}

let session: ProtectSession | null = null;
let statusCache: { data: ProtectStatus; expiresAt: number } | null = null;

async function getHost(): Promise<string> {
	const settings = await getSettings('unifi_');
	const host = settings.unifi_host;
	if (!host) throw new Error('UniFi host not configured. Set unifi_host in Settings.');
	return host;
}

async function login(): Promise<ProtectSession> {
	const settings = await getSettings('unifi_');
	const host = settings.unifi_host;
	if (!host) throw new Error('UniFi host not configured');

	const username = settings.unifi_username;
	const password = settings.unifi_password; // already decrypted by getSettings()

	if (!username || !password) {
		throw new Error('UniFi credentials not configured');
	}

	const res = await fetch(`https://${host}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});

	if (!res.ok) {
		throw new Error(`Protect login failed: ${res.status} ${res.statusText}`);
	}

	const cookies = res.headers.getSetCookie().join('; ');
	const csrfToken = res.headers.get('x-csrf-token') || '';

	return {
		cookies,
		csrfToken,
		expiresAt: Date.now() + 8 * 60 * 1000 // 8 min safety margin (session ~10min)
	};
}

export async function protectFetch(path: string): Promise<Response> {
	if (!session || Date.now() > session.expiresAt) {
		session = await login();
	}

	const host = await getHost();
	let res = await fetch(`https://${host}/proxy/protect/api/${path}`, {
		headers: {
			Cookie: session.cookies,
			'X-CSRF-Token': session.csrfToken
		}
	});

	// Retry once on 401
	if (res.status === 401) {
		session = await login();
		res = await fetch(`https://${host}/proxy/protect/api/${path}`, {
			headers: {
				Cookie: session.cookies,
				'X-CSRF-Token': session.csrfToken
			}
		});
	}

	if (!res.ok) {
		throw new Error(`Protect API error: ${res.status} ${res.statusText} for ${path}`);
	}

	return res;
}

export async function getProtectCameras(): Promise<ProtectCamera[]> {
	const res = await protectFetch('cameras');
	const data = await res.json();
	return data as ProtectCamera[];
}

export function matchCamerasToProtect(
	ourCameras: { id: number; vmid: number; ip: string; containerIp: string | null; lxcMac: string | null }[],
	protectCameras: ProtectCamera[]
): Map<number, ProtectCameraMatch> {
	const matches = new Map<number, ProtectCameraMatch>();

	for (const cam of ourCameras) {
		let match: ProtectCamera | undefined;

		// Primary: match by MAC address (survives DHCP changes)
		if (cam.lxcMac) {
			const normalizedMac = cam.lxcMac.toUpperCase().replace(/[:-]/g, '');
			const candidates = protectCameras.filter((p) => {
				const pMac = (p.mac || '').toUpperCase().replace(/[:-]/g, '');
				return pMac === normalizedMac;
			});
			match = candidates.find((p) => p.isAdopted && p.state === 'CONNECTED')
				?? candidates.find((p) => p.isAdopted)
				?? candidates[0];
		}

		// Fallback: match by IP (for cameras without MAC or native ONVIF)
		if (!match) {
			const matchIp = cam.vmid > 0 ? cam.containerIp : cam.ip;
			if (!matchIp) continue;

			const candidates = protectCameras.filter((p) => p.host === matchIp);
			match = candidates.find((p) => p.isAdopted && p.state === 'CONNECTED')
				?? candidates.find((p) => p.isAdopted)
				?? candidates[0];
		}

		if (match) {
			matches.set(cam.id, {
				protectId: match.id,
				protectName: match.name,
				state: match.state,
				isAdopted: match.isAdopted,
				connectedSince: match.connectedSince || null,
				isThirdPartyCamera: match.isThirdPartyCamera
			});
		}
	}

	return matches;
}

export async function getProtectStatus(
	macMap?: Map<number, string | null>
): Promise<ProtectStatus> {
	// Return cached data if still valid (30s TTL)
	if (statusCache && Date.now() < statusCache.expiresAt) {
		return statusCache.data;
	}

	try {
		const protectCameras = await getProtectCameras();

		// Load our cameras from DB
		const ourCameras = db.select().from(cameras).all();

		const cameraMatches = matchCamerasToProtect(
			ourCameras.map((c) => ({
				id: c.id,
				vmid: c.vmid,
				ip: c.ip,
				containerIp: c.containerIp,
				lxcMac: macMap?.get(c.id) ?? null
			})),
			protectCameras
		);

		const adoptedCount = protectCameras.filter((c) => c.isAdopted).length;
		const connectedCount = protectCameras.filter(
			(c) => c.state === 'CONNECTED' && c.isAdopted
		).length;

		const status: ProtectStatus = {
			connected: true,
			adoptedCount,
			connectedCount,
			totalProtectCameras: protectCameras.length,
			cameras: cameraMatches
		};

		// Cache for 30s
		statusCache = { data: status, expiresAt: Date.now() + 30_000 };
		return status;
	} catch (err) {
		const msg = (err as Error).message;
		// Don't spam logs when Protect is simply not configured
		if (!msg.includes('not configured')) {
			console.error('[protect] Status fetch failed:', msg);
		}
		// Do NOT cache failures
		return {
			connected: false,
			adoptedCount: 0,
			connectedCount: 0,
			totalProtectCameras: 0,
			cameras: new Map()
		};
	}
}

export async function verifyOnvifServer(
	containerIp: string
): Promise<{ running: boolean; reachable: boolean }> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);

		await fetch(`http://${containerIp}:8899`, {
			signal: controller.signal
		});
		clearTimeout(timeout);

		return { running: true, reachable: true };
	} catch (err: unknown) {
		// ECONNRESET means server is running but reset the connection
		if (err instanceof Error && 'cause' in err) {
			const cause = err.cause as { code?: string };
			if (cause?.code === 'ECONNRESET') {
				return { running: true, reachable: true };
			}
		}
		if (err instanceof Error && err.message?.includes('ECONNRESET')) {
			return { running: true, reachable: true };
		}

		return { running: false, reachable: false };
	}
}
