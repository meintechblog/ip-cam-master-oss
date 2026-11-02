import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encrypt } from '$lib/server/services/crypto';
import { BAMBU_MODEL_ALLOWLIST, normalizeBambuModel } from '$lib/server/services/bambu-discovery';
import { CAMERA_STATUS } from '$lib/types';

// Bambu cameras are saved BEFORE LXC provisioning (Phase 12 will create the
// container and update vmid). vmid=0 is the sentinel for "awaiting provisioning".
const BAMBU_PENDING_VMID = 0;

/**
 * IPv4 dotted-quad validation with per-octet range check (0-255).
 *
 * Phase 18 / CR-01: This is the security gate that keeps user-supplied IPs
 * from flowing into the go2rtc `exec:` command line unescaped. A naive
 * `/^(\d{1,3}\.){3}\d{1,3}$/` would accept "999.999.999.999"; we additionally
 * assert every octet is 0-255 so the value cannot carry arbitrary digits or
 * overflow a downstream parser.
 */
function isValidIPv4(value: string): boolean {
	if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
	return value.split('.').every((octet) => {
		const n = Number(octet);
		return Number.isInteger(n) && n >= 0 && n <= 255;
	});
}

export const POST: RequestHandler = async ({ request }) => {
	const { name, ip, serialNumber, accessCode, model } = await request.json();

	if (!name || !ip || !serialNumber || !accessCode) {
		return json(
			{ success: false, error: 'Name, IP, Seriennummer und Access Code erforderlich' },
			{ status: 400 }
		);
	}
	if (typeof accessCode !== 'string' || accessCode.length !== 8) {
		return json(
			{ success: false, error: 'Access Code muss 8 Zeichen lang sein' },
			{ status: 400 }
		);
	}
	// Phase 18 / CR-01: Bambu access codes are 8 digits. Enforce server-side so
	// the value cannot flow into the go2rtc exec: line as a shell/YAML-injection
	// sink (see generateGo2rtcConfigBambuA1 in src/lib/server/services/go2rtc.ts).
	if (!/^[0-9]{8}$/.test(accessCode)) {
		return json(
			{ success: false, error: 'Access Code muss 8 Ziffern sein' },
			{ status: 400 }
		);
	}
	// Phase 18 / CR-01: IP must be an IPv4 dotted-quad with per-octet range check.
	// Refuses whitespace, shell meta-characters, YAML fence (#), and bogus
	// quads like 999.999.999.999 that could leak past a naive regex.
	if (typeof ip !== 'string' || !isValidIPv4(ip)) {
		return json(
			{ success: false, error: 'IP muss eine gültige IPv4-Adresse sein' },
			{ status: 400 }
		);
	}

	// Phase 18 / BAMBU-A1-02: SSDP-discovered model drives the capability matrix.
	// Validated against allowlist — an attacker-crafted model cannot flow into
	// `PRINTER_CAPABILITIES[model]` as an arbitrary key (T-18-29). Unknown or
	// absent → null, and the UI/preflight fall back to H2C defaults.
	const rawModel = typeof model === 'string' ? model.trim() : '';
	// Validate against allowlist first (T-18-29), THEN normalize wire-code to
	// canonical product code so downstream `model === 'A1' | 'H2C'` checks
	// remain simple without needing to know about SSDP wire aliases.
	const validatedModel = (BAMBU_MODEL_ALLOWLIST as readonly string[]).includes(rawModel)
		? normalizeBambuModel(rawModel)
		: null;

	const existing = db.select().from(cameras).where(eq(cameras.ip, ip)).get();
	if (existing) {
		return json({ success: true, cameraId: existing.id, alreadyExisted: true });
	}

	const result = db
		.insert(cameras)
		.values({
			vmid: BAMBU_PENDING_VMID,
			name,
			ip,
			username: 'bblp',
			password: '',
			cameraType: 'bambu',
			streamPath: '/streaming/live/1',
			width: 1680,
			height: 1080,
			fps: 30,
			bitrate: 2000,
			streamName: `bambu-${serialNumber.slice(-6)}`,
			status: CAMERA_STATUS.PENDING,
			accessCode: encrypt(accessCode),
			serialNumber,
			model: validatedModel,
			// Bambu go2rtc locks RTSP with serial as username + access code
			// as password — exactly the pair the user types in UniFi Protect.
			rtspAuthEnabled: true,
			// Adaptive mode was designed for H2C to rest its fragile Live555
			// RTSPS server during idle cycles. A1 uses a custom JPEG-over-TLS
			// pipeline on :6000 that does not stress Live555, so gating go2rtc
			// on/off by print state only breaks Protect adoption (go2rtc
			// 'stopped' = stream offline, systemd Restart=always does not fire
			// after an explicit `systemctl stop`). Keep A1 always-live.
			streamMode: validatedModel === 'A1' ? 'always_live' : 'adaptive'
		})
		.run();

	return json({ success: true, cameraId: Number(result.lastInsertRowid) });
};
