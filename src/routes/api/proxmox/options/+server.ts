import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSettings } from '$lib/server/services/settings';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const GET: RequestHandler = async () => {
	try {
		const settings = await getSettings('proxmox_');
		const host = settings.proxmox_host?.replace(/:.*$/, '');
		const tokenId = settings.proxmox_token_id;
		const tokenSecret = settings.proxmox_token_secret;

		if (!host || !tokenId || !tokenSecret) {
			return json({ bridges: [], storages: [], error: 'Proxmox nicht konfiguriert' });
		}

		const authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`;

		// Get node name first
		const { stdout: nodesJson } = await execAsync(
			`curl -sk -H "Authorization: ${authHeader}" "https://${host}:8006/api2/json/nodes" --max-time 3`,
			{ timeout: 5000, encoding: 'utf-8' }
		);
		const nodes = JSON.parse(nodesJson).data || [];
		const nodeName = nodes[0]?.node;
		if (!nodeName) return json({ bridges: [], storages: [], error: 'Kein Node gefunden' });

		// Get bridges and storage in parallel
		const [bridgeResult, storageResult] = await Promise.allSettled([
			execAsync(
				`curl -sk -H "Authorization: ${authHeader}" "https://${host}:8006/api2/json/nodes/${nodeName}/network" --max-time 3`,
				{ timeout: 5000, encoding: 'utf-8' }
			),
			execAsync(
				`curl -sk -H "Authorization: ${authHeader}" "https://${host}:8006/api2/json/nodes/${nodeName}/storage" --max-time 3`,
				{ timeout: 5000, encoding: 'utf-8' }
			)
		]);

		const bridges: { name: string; comment: string }[] = [];
		if (bridgeResult.status === 'fulfilled') {
			const data = JSON.parse(bridgeResult.value.stdout).data || [];
			for (const d of data) {
				if (d.type === 'bridge') {
					bridges.push({ name: d.iface, comment: (d.comments || '').trim() });
				}
			}
		}

		const storages: { name: string; type: string; totalGB: number; availGB: number }[] = [];
		if (storageResult.status === 'fulfilled') {
			const data = JSON.parse(storageResult.value.stdout).data || [];
			for (const s of data) {
				if (s.content?.includes('rootdir')) {
					storages.push({
						name: s.storage,
						type: s.type,
						totalGB: Math.round((s.total || 0) / 1024 / 1024 / 1024),
						availGB: Math.round((s.avail || 0) / 1024 / 1024 / 1024)
					});
				}
			}
		}

		return json({ bridges, storages });
	} catch (err) {
		return json({ bridges: [], storages: [], error: err instanceof Error ? err.message : 'Fehler' });
	}
};
