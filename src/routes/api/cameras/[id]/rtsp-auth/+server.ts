import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { configureGo2rtc } from '$lib/server/services/onboarding';

/**
 * Toggle go2rtc RTSP auth on or off for a single camera.
 *
 * Body: { enabled: boolean }
 *
 * On enable: flip `rtsp_auth_enabled`, regenerate go2rtc.yaml with the
 * camera's own credentials (Mobotix/Loxone: username/password, Bambu:
 * serial/access_code), push to the container, restart go2rtc.
 *
 * The caller is expected to prompt the user to re-adopt the camera in
 * UniFi Protect afterwards — existing adoptions still point at an
 * unauthenticated RTSP endpoint and will start failing until Protect
 * learns the new credentials.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	const cameraId = parseInt(params.id);
	if (!Number.isFinite(cameraId)) {
		return json({ success: false, error: 'Ungültige Kamera-ID' }, { status: 400 });
	}

	const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
	if (typeof body.enabled !== 'boolean') {
		return json({ success: false, error: 'Feld "enabled" (boolean) erforderlich' }, { status: 400 });
	}

	const camera = db.select().from(cameras).where(eq(cameras.id, cameraId)).get();
	if (!camera) {
		return json({ success: false, error: 'Kamera nicht gefunden' }, { status: 404 });
	}
	if (!camera.vmid || camera.vmid === 0) {
		return json(
			{ success: false, error: 'RTSP-Auth gilt nur für Container-basierte Kameras (kein Native-ONVIF)' },
			{ status: 400 }
		);
	}

	// Update DB first — configureGo2rtc reads rtsp_auth_enabled from the row.
	db.update(cameras)
		.set({ rtspAuthEnabled: body.enabled, updatedAt: new Date().toISOString() })
		.where(eq(cameras.id, cameraId))
		.run();

	try {
		await configureGo2rtc(cameraId, /* skipInstall */ true);
	} catch (err) {
		// Roll back flag so the UI reflects the live state of the container.
		db.update(cameras)
			.set({ rtspAuthEnabled: !body.enabled, updatedAt: new Date().toISOString() })
			.where(eq(cameras.id, cameraId))
			.run();
		const message = err instanceof Error ? err.message : String(err);
		return json(
			{ success: false, error: `Redeploy fehlgeschlagen: ${message}` },
			{ status: 500 }
		);
	}

	return json({
		success: true,
		rtspAuthEnabled: body.enabled,
		needsReadopt: body.enabled,
		message: body.enabled
			? 'RTSP-Auth aktiviert. In UniFi Protect muss die Kamera neu adoptiert werden — die bestehende Adoption nutzt keinen Login.'
			: 'RTSP-Auth deaktiviert. Protect verbindet ohne Credentials.'
	});
};
