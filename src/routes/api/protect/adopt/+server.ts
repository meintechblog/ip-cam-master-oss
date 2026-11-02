import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { verifyOnvifServer } from '$lib/server/services/protect';
import { getSetting } from '$lib/server/services/settings';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { cameraId } = await request.json();

		if (!cameraId || typeof cameraId !== 'number') {
			return json({ error: 'cameraId (number) ist erforderlich' }, { status: 400 });
		}

		const cam = db.select().from(cameras).where(eq(cameras.id, cameraId)).get();
		if (!cam) {
			return json({ error: `Kamera mit ID ${cameraId} nicht gefunden` }, { status: 404 });
		}

		const isNativeOnvif = cam.vmid === 0 || cam.status === 'native-onvif' || cam.cameraType === 'mobotix-onvif';
		const targetIp = isNativeOnvif ? cam.ip : cam.containerIp;

		if (!targetIp) {
			return json({
				error: 'Keine IP für diese Kamera konfiguriert',
				onvifRunning: false,
				containerReachable: false,
				instructions: []
			}, { status: 400 });
		}

		const unifiHost = await getSetting('unifi_host');

		// Native ONVIF cameras don't need ONVIF server check — they ARE ONVIF devices
		if (isNativeOnvif) {
			return json({
				onvifRunning: true,
				containerReachable: true,
				instructions: [
					`Öffne UniFi Protect auf https://${unifiHost || '<UniFi-Host>'}`,
					'Navigiere zu Geräte \u2192 Übernehmen',
					`Kamera '${cam.name}' sollte als ONVIF-Gerät erscheinen (IP: ${targetIp})`,
					"Klicke auf 'Übernehmen' (Adopt)",
					'Die Kamera wird direkt per ONVIF eingebunden — kein Container nötig'
				],
				protectUrl: unifiHost ? `https://${unifiHost}/protect/devices` : null
			});
		}

		const onvifCheck = await verifyOnvifServer(targetIp);

		if (!onvifCheck.running) {
			return json({
				onvifRunning: false,
				containerReachable: onvifCheck.reachable,
				instructions: [
					`ONVIF-Server läuft nicht auf Container ${targetIp}. Bitte Container neu starten.`
				],
				protectUrl: unifiHost ? `https://${unifiHost}/protect/devices` : null
			});
		}

		return json({
			onvifRunning: true,
			containerReachable: true,
			instructions: [
				`Öffne UniFi Protect auf https://${unifiHost || '<UniFi-Host>'}`,
				'Navigiere zu Geräte \u2192 Übernehmen',
				`Kamera '${cam.name}' sollte in der Liste erscheinen (IP: ${targetIp})`,
				"Klicke auf 'Übernehmen' (Adopt)"
			],
			protectUrl: unifiHost ? `https://${unifiHost}/protect/devices` : null
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: message }, { status: 500 });
	}
};
