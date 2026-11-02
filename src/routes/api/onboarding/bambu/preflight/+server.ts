import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runBambuPreflight, realDeps } from '$lib/server/services/bambu-preflight';
import { BAMBU_MODEL_ALLOWLIST } from '$lib/server/services/bambu-discovery';

/**
 * IPv4 dotted-quad validation with per-octet range check (0-255).
 *
 * Phase 18 / CR-01 defence-in-depth: refuses anything that could carry
 * shell/YAML meta-characters into downstream go2rtc config (save-camera
 * enforces the same invariant; this keeps preflight honest so a caller
 * cannot reach TLS handshakes with a malformed IP).
 */
function isValidIPv4(value: string): boolean {
	if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
	return value.split('.').every((octet) => {
		const n = Number(octet);
		return Number.isInteger(n) && n >= 0 && n <= 255;
	});
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}) as Record<string, unknown>);
	const ip = typeof body?.ip === 'string' ? body.ip.trim() : '';
	const serialNumber = typeof body?.serialNumber === 'string' ? body.serialNumber.trim() : '';
	const accessCode = typeof body?.accessCode === 'string' ? body.accessCode.trim() : '';

	// Phase 18 / BAMBU-A1-04: optional model param. Validated against the
	// allowlist so an attacker cannot pass an arbitrary string through to
	// `PRINTER_CAPABILITIES[model]`. Unknown / absent → fall back to 'H2C'
	// (preflight also falls back internally; defence in depth).
	const rawModel = typeof body?.model === 'string' ? body.model.trim() : '';
	const model = (BAMBU_MODEL_ALLOWLIST as readonly string[]).includes(rawModel) ? rawModel : 'H2C';

	if (!ip || !serialNumber || !accessCode || accessCode.length !== 8) {
		return json(
			{
				ok: false,
				error: 'INVALID_INPUT',
				hint: 'IP, Seriennummer und Access Code (8 Zeichen) sind erforderlich.'
			},
			{ status: 400 }
		);
	}

	// Phase 18 / CR-01: IPv4 dotted-quad only (LAN scope). Match save-camera
	// so preflight cannot be the weaker gate that sends raw user input into
	// the TLS stack or downstream go2rtc config generation.
	if (!isValidIPv4(ip)) {
		return json(
			{
				ok: false,
				error: 'INVALID_INPUT',
				hint: 'IP muss eine gültige IPv4-Adresse sein.'
			},
			{ status: 400 }
		);
	}
	// Phase 18 / CR-01 + IN-01: Bambu access codes are exactly 8 digits.
	// save-camera already enforces this — mirror here so the preflight surface
	// cannot accept wider alphabets in a later regression.
	if (!/^[0-9]{8}$/.test(accessCode)) {
		return json(
			{
				ok: false,
				error: 'INVALID_INPUT',
				hint: 'Access Code muss 8 Ziffern sein.'
			},
			{ status: 400 }
		);
	}

	try {
		const result = await runBambuPreflight(
			{ ip, serialNumber, accessCode },
			realDeps,
			model
		);
		return json(result);
	} catch (err) {
		return json(
			{
				ok: false,
				error: 'PRINTER_UNREACHABLE',
				hint: err instanceof Error ? err.message : 'Unbekannter Fehler'
			},
			{ status: 500 }
		);
	}
};
