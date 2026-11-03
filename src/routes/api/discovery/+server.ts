import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { cameras, credentials } from '$lib/server/db/schema';
import { decrypt } from '$lib/server/services/crypto';
import {
	discoverBambuDevices,
	normalizeBambuModel
} from '$lib/server/services/bambu-discovery';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fix common German umlaut replacements (Mobotix camera titles lack UTF-8)
// Uses word-boundary-aware replacement to avoid false positives
function fixGermanUmlauts(name: string): string {
	const replacements: [RegExp, string][] = [
		[/(?<=[A-Z])ue(?=[a-z])/g, 'ü'],    // Haustuer → Haustür
		[/(?<=[a-z])ue(?=[a-z]|$)/g, 'ü'],   // haustuer → haustür
		[/^Ue(?=[a-z])/g, 'Ü'],              // Uebersicht → Übersicht
		[/(?<=[A-Z])ae(?=[a-z])/g, 'ä'],      // Gaeste → Gäste
		[/(?<=[a-z])ae(?=[a-z]|$)/g, 'ä'],
		[/^Ae(?=[a-z])/g, 'Ä'],
		[/(?<=[A-Z])oe(?=[a-z])/g, 'ö'],      // Hoehe → Höhe
		[/(?<=[a-z])oe(?=[a-z]|$)/g, 'ö'],
		[/^Oe(?=[a-z])/g, 'Ö'],
	];
	for (const [pattern, replacement] of replacements) {
		name = name.replace(pattern, replacement);
	}
	return name;
}

const execAsync = promisify(exec);

// Read at most `limit` bytes of a response body (the <title> sits in the page head;
// keeps memory bounded like the old curl/execAsync buffer did)
async function readHead(res: Response, limit = 64 * 1024): Promise<string> {
	if (!res.body) return '';
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			const part = value.subarray(0, limit - size);
			chunks.push(part);
			size += part.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export interface DiscoveredCamera {
	ip: string;
	type: 'mobotix' | 'mobotix-onvif' | 'loxone' | 'bambu' | 'unknown';
	alreadyOnboarded: boolean;
	name: string | null;
	// Optional Bambu-only annotations (set only when type === 'bambu'):
	serialNumber?: string;
	model?: string;
	lanModeHint?: 'likely_on';
}

export const GET: RequestHandler = async ({ url }) => {
	const subnet = url.searchParams.get('subnet') || '192.168.1';
	const rangeStart = parseInt(url.searchParams.get('start') || '1');
	const rangeEnd = parseInt(url.searchParams.get('end') || '254');

	try {
		const onboarded = new Set(
			(db.select().from(cameras).all() as any[]).map((c) => c.ip)
		);

		// Factored so the existing HTTP-probe scan can run in parallel with the
		// SSDP listener via Promise.all. Behavior is preserved bit-for-bit from
		// the pre-change code — only the surrounding wrapper is new.
		const runExistingHttpScan = async (): Promise<DiscoveredCamera[]> => {
			// Write scan script to temp file to avoid shell quoting issues
			const scriptPath = join(tmpdir(), `ipcam-scan-${Date.now()}.sh`);
			writeFileSync(scriptPath, `#!/bin/bash
for ip in $(seq ${rangeStart} ${rangeEnd}); do
  (
    FULL="${subnet}.$ip"
    RESP=$(curl -s --max-time 1 "http://$FULL/" 2>/dev/null | head -c 2000)
    # Loxone Intercom: @VERSION 1.0.x in HTML (Audioserver is 2.x)
    if echo "$RESP" | grep -q "@VERSION 1[.]0"; then
      echo "loxone:$FULL"
    else
      # Mobotix: follow redirect, check for 'mobotix' in page
      RESP_L=$(curl -s --max-time 1 -L "http://$FULL/" 2>/dev/null | head -c 2000)
      if echo "$RESP_L" | grep -qi "mobotix"; then
        # Check native ONVIF support (405 = endpoint exists, needs POST)
        ONVIF_CODE=$(curl -s --max-time 1 -o /dev/null -w "%{http_code}" "http://$FULL/onvif/device_service" 2>/dev/null)
        if [ "$ONVIF_CODE" = "405" ] || [ "$ONVIF_CODE" = "200" ]; then
          echo "mobotix-onvif:$FULL"
        else
          echo "mobotix:$FULL"
        fi
      fi
    fi
  ) &
done
wait
`, { mode: 0o755 });

			const { stdout } = await execAsync(`bash ${scriptPath}`, {
				timeout: 60000,
				encoding: 'utf-8'
			});

			// Clean up
			try { unlinkSync(scriptPath); } catch { /* ignore */ }

			// Get saved credentials for name lookup
			const savedCreds = (db.select().from(credentials).all() as any[])
				.sort((a, b) => a.priority - b.priority)
				.map((c) => { try { return { u: c.username, p: decrypt(c.password) }; } catch { return null; } })
				.filter(Boolean) as { u: string; p: string }[];

			const discovered: DiscoveredCamera[] = stdout
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const colonIdx = line.indexOf(':');
					const type = line.substring(0, colonIdx) as DiscoveredCamera['type'];
					const ip = line.substring(colonIdx + 1);
					return {
						ip,
						type,
						alreadyOnboarded: onboarded.has(ip),
						name: null as string | null
					};
				});

			// Try to grab camera names using saved credentials
			if (savedCreds.length > 0) {
				await Promise.allSettled(
					discovered.filter((c) => !c.alreadyOnboarded).map(async (cam) => {
						for (const cred of savedCreds) {
							try {
								// fetch instead of a shell curl: credentials never reach a shell or the process list
								const res = await fetch(`http://${cam.ip}/`, {
									headers: {
										Authorization: `Basic ${Buffer.from(`${cred.u}:${cred.p}`).toString('base64')}`
									},
									redirect: 'follow',
									signal: AbortSignal.timeout(2000)
								});
								const html = await readHead(res);
								const titleMatch = html.match(/<title>([^<]+)<\/title>/);
								if (titleMatch) {
									let name = titleMatch[1].replace(/ Live$/, '').replace(/Error.*/, '').trim();
									// Fix German umlaut replacements from Mobotix (camera title has no UTF-8)
									name = fixGermanUmlauts(name);
									if (name && !name.includes('Error') && !name.includes('Unauthorized')) {
										cam.name = name;
										break;
									}
								}
							} catch { /* try next cred */ }
						}
					})
				);
			}

			return discovered;
		};

		// Run the existing HTTP-probe scan and the Bambu SSDP listener in parallel.
		// discoverBambuDevices never rejects — it resolves to [] on socket error
		// (e.g. EADDRINUSE on UDP 2021) so the HTTP scan result is authoritative
		// for non-Bambu devices even if UDP is blocked.
		// 12s listen window: Bambu SSDP cadence is ~10-15s per broadcast.
		// A 6s window hit a single broadcast only ~50% of the time during
		// live testing (A1 @ 192.0.2.195 on 2026-04-21). 12s virtually
		// guarantees at least one broadcast per scan without feeling slow.
		const [httpScanResult, bambuDevices] = await Promise.all([
			runExistingHttpScan(),
			discoverBambuDevices({ listenMs: 12000 })
		]);

		const bambuRows: DiscoveredCamera[] = bambuDevices.map((d) => ({
			ip: d.ip,
			type: 'bambu' as const,
			alreadyOnboarded: onboarded.has(d.ip),
			name: d.name,
			serialNumber: d.serialNumber,
			// Normalize wire code (O1C2/N2S) to canonical product code
			// (H2C/A1) so the wizard can do simple `model === 'A1'` checks
			// without knowing the SSDP alias namespace.
			model: normalizeBambuModel(d.model),
			// SSDP only fires when LAN Mode is on; not authoritative (real check
			// lives in the pre-flight handler — Plan 11-03).
			lanModeHint: 'likely_on' as const
		}));

		// Merge: Bambu rows take precedence over HTTP-scan rows on IP collision,
		// since the Bambu annotation (serial, model, lanModeHint) is strictly
		// more informative than a generic 'unknown'/'mobotix' row.
		const byIp = new Map<string, DiscoveredCamera>();
		for (const row of httpScanResult) byIp.set(row.ip, row);
		for (const row of bambuRows) byIp.set(row.ip, row);

		const merged = [...byIp.values()].sort((a, b) => {
			const aNum = parseInt(a.ip.split('.').pop() || '0');
			const bNum = parseInt(b.ip.split('.').pop() || '0');
			return aNum - bNum;
		});

		return json({ cameras: merged });
	} catch (err) {
		return json({ cameras: [], error: err instanceof Error ? err.message : 'Scan failed' });
	}
};
