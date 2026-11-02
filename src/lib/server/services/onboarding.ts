import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectToProxmox, executeOnContainer, pushFileToContainer, waitForContainerReady } from './ssh';
import { generateGo2rtcConfig, generateGo2rtcConfigLoxone, generateGo2rtcConfigBambu, generateGo2rtcConfigBambuA1, generateSystemdUnit, getInstallCommands, checkStreamHealth, getOnvifInstallCommands, generateOnvifConfig, generateOnvifSystemdUnit, generateNginxConfig, getNginxInstallCommands, getOnvifAudioPatch, getOnvifSoapPatch, type RtspAuth } from './go2rtc';
import { createContainer, startContainer, getTemplateVmid, cloneFromTemplate, createTemplateFromContainer } from './proxmox';
import { encrypt, decrypt } from './crypto';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { Camera, StreamInfo } from '$lib/types';
import { CAMERA_STATUS } from '$lib/types';

/**
 * Canonical username the user types in UniFi Protect's adoption dialog
 * for a Bambu-backed go2rtc container. Not the upstream Bambu cloud
 * identity (that's `bblp` in bambu-credentials.ts) — just a short,
 * memorable RTSP user that the go2rtc server enforces.
 */
export const BAMBU_ADOPTION_USERNAME = 'bambu';

/**
 * Build RTSP auth credentials for a camera's go2rtc server, if opt-in is active.
 * - Mobotix/Loxone: camera.username + decrypt(camera.password)
 * - Bambu: constant "bambu" + decrypt(camera.access_code)
 *   (the access code is the actual secret; a short, shared username keeps
 *   the Protect adoption dialog fast to type)
 *
 * Returns undefined when rtsp_auth_enabled is false or required fields are
 * missing, so the generator emits an unauthenticated go2rtc.yaml (legacy
 * behavior) without risking a broken deploy.
 */
export function buildRtspAuth(
	camera: {
		cameraType: string;
		rtspAuthEnabled?: boolean;
		username: string;
		password: string;
		accessCode?: string | null;
		serialNumber?: string | null;
	}
): RtspAuth | undefined {
	if (!camera.rtspAuthEnabled) return undefined;

	if (camera.cameraType === 'bambu') {
		if (!camera.accessCode) return undefined;
		return { username: BAMBU_ADOPTION_USERNAME, password: decrypt(camera.accessCode) };
	}

	if (!camera.username || !camera.password) return undefined;
	return { username: camera.username, password: decrypt(camera.password) };
}

/**
 * Tests connectivity to a Mobotix camera by probing its RTSP stream via ffprobe over SSH.
 */
export async function testMobotixConnection(
	ip: string,
	username: string,
	password: string
): Promise<{ success: boolean; resolution?: string; fps?: number; streamPath?: string; cameraModel?: string; error?: string }> {
	const ssh = await connectToProxmox();

	try {
		// Detect camera model from /admin/version (e.g. "MOBOTIX S15D-Sec")
		let cameraModel: string | undefined;
		try {
			const versionResult = await ssh.execCommand(
				`curl -s --basic -u "${username}:${password}" "http://${ip}/admin/version" --max-time 3`
			);
			const tdMatches = (versionResult.stdout || '').match(/<td[^>]*>(.*?)<\/td>/gs) || [];
			const tdTexts = tdMatches.map((td: string) => td.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
			if (tdTexts.length > 0 && tdTexts[0].includes('MOBOTIX')) {
				cameraModel = tdTexts[0]; // e.g. "MOBOTIX S15D-Sec"
			}
		} catch { /* optional */ }

		// Try primary stream path
		const primaryPath = '/stream0/mobotix.mjpeg';
		const probeCmd = `ffprobe -v quiet -print_format json -show_streams -timeout 5000000 rtsp://${username}:${password}@${ip}:554${primaryPath} 2>&1 || echo PROBE_FAILED`;

		const result = await ssh.execCommand(probeCmd);

		if (result.stdout && !result.stdout.includes('PROBE_FAILED')) {
			const parsed = parseProbeResult(result.stdout);
			if (parsed) {
				return { success: true, ...parsed, streamPath: primaryPath, cameraModel };
			}
		}

		// Try alternate path
		const altPath = '/mobotix.mjpeg';
		const altCmd = `ffprobe -v quiet -print_format json -show_streams -timeout 5000000 rtsp://${username}:${password}@${ip}:554${altPath} 2>&1 || echo PROBE_FAILED`;

		const altResult = await ssh.execCommand(altCmd);

		if (altResult.stdout && !altResult.stdout.includes('PROBE_FAILED')) {
			const parsed = parseProbeResult(altResult.stdout);
			if (parsed) {
				return { success: true, ...parsed, streamPath: altPath, cameraModel };
			}
		}

		// Fallback: TCP connect test to port 554 + read config from Mobotix HTTP API
		const tcpCmd = `timeout 3 bash -c 'echo > /dev/tcp/${ip}/554' 2>/dev/null && echo REACHABLE || echo UNREACHABLE`;
		const tcpResult = await ssh.execCommand(tcpCmd);

		if (tcpResult.stdout?.includes('REACHABLE')) {
			// Read resolution + FPS from Mobotix config API
			let resolution: string | undefined;
			let fps: number | undefined;
			try {
				const configResult = await ssh.execCommand(
					`curl -s --basic -u "${username}:${password}" "http://${ip}/control/control?read&section=general&framerate100&customsize" --max-time 3`
				);
				const configText = configResult.stdout || '';
				const sizeMatch = configText.match(/customsize=(\d+x\d+)/);
				if (sizeMatch) resolution = sizeMatch[1];
				const fpsMatch = configText.match(/framerate100=(\d+)/);
				if (fpsMatch) fps = parseInt(fpsMatch[1]) / 100;
			} catch { /* ignore */ }

			return {
				success: true,
				resolution,
				fps,
				streamPath: primaryPath,
				cameraModel
			};
		}

		return { success: false, error: 'Camera not reachable on RTSP port 554' };
	} finally {
		ssh.dispose();
	}
}

function parseProbeResult(stdout: string): { resolution?: string; fps?: number } | null {
	try {
		const data = JSON.parse(stdout);
		const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
		if (!videoStream) return null;

		const resolution = videoStream.width && videoStream.height
			? `${videoStream.width}x${videoStream.height}`
			: undefined;

		let fps: number | undefined;
		if (videoStream.r_frame_rate) {
			const parts = videoStream.r_frame_rate.split('/');
			fps = parts.length === 2 ? Math.round(parseInt(parts[0]) / parseInt(parts[1])) : parseInt(parts[0]);
		}

		return { resolution, fps };
	} catch {
		return null;
	}
}

/**
 * Saves a camera record to the database.
 *
 * `model` (Phase 18 / BAMBU-A1-02) is optional. For Bambu cameras this is
 * the SSDP-captured DevModel (e.g. 'A1', 'H2C', 'O1C2') which drives the
 * per-model capability matrix downstream (`PRINTER_CAPABILITIES`). Nullable:
 * legacy rows and non-Bambu cameras pass null and the UI falls back to H2C
 * capabilities for any pre-Phase-18 Bambu rows.
 */
export async function saveCameraRecord(params: {
	name: string;
	ip: string;
	username: string;
	password: string;
	cameraType?: string;
	streamPath?: string;
	width?: number;
	height?: number;
	fps?: number;
	bitrate?: number;
	vmid: number;
	streamName?: string;
	model?: string | null;
}): Promise<number> {
	const encryptedPassword = encrypt(params.password);
	const streamName = params.streamName || `cam-${params.vmid}`;

	db.insert(cameras)
		.values({
			vmid: params.vmid,
			name: params.name,
			ip: params.ip,
			username: params.username,
			password: encryptedPassword,
			cameraType: params.cameraType || 'mobotix',
			streamPath: params.streamPath || '/stream0/mobotix.mjpeg',
			width: params.width || 1280,
			height: params.height || 720,
			fps: params.fps || 20,
			bitrate: params.bitrate || 2000,
			streamName,
			status: CAMERA_STATUS.PENDING,
			// New Mobotix/Loxone onboardings lock RTSP with the user-provided
			// camera credentials. Protect will prompt for them during adoption.
			rtspAuthEnabled: true,
			// Phase 18 / BAMBU-A1-02: persist SSDP-captured model for Bambu rows
			// so downstream capability checks (UI + preflight) have real data.
			model: params.model ?? null
		})
		.run();

	// Get the inserted camera by vmid
	const inserted = db.select({ id: cameras.id }).from(cameras).where(eq(cameras.vmid, params.vmid)).get();
	return inserted?.id ?? 0;
}

/**
 * Creates an LXC container for a camera, starts it, discovers its IP.
 */
export async function createCameraContainer(
	cameraId: number
): Promise<{ vmid: number; containerIp: string; fromTemplate: boolean }> {
	const camera = getCameraById(cameraId);

	// Hostname from camera name: lowercase, no spaces/special chars
	const hostname = `cam-${camera.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

	// Phase 18 / BAMBU-A1-08: Bambu A1 runs an ffmpeg MJPEG→H264 transcode
	// inside the LXC (peaks ~180 MB RAM). Default 192 MB template → swap
	// thrash + go2rtc clean-exit. All other cameras stay on the tight
	// default since their pipelines are just RTSP relay (~40 MB).
	const containerMemoryMb =
		camera.cameraType === 'bambu' && camera.model === 'A1' ? 1024 : undefined;

	// Try to clone from template (fast path: ~10s instead of 3-5min)
	let fromTemplate = false;
	const templateVmid = await getTemplateVmid();
	if (templateVmid) {
		await cloneFromTemplate({
			templateVmid,
			vmid: camera.vmid,
			hostname,
			cameraName: camera.name,
			cameraIp: camera.ip,
			cameraType: camera.cameraType,
			memory: containerMemoryMb
		});
		fromTemplate = true;
	} else {
		// No template yet — fresh install (first camera)
		// Ensure Debian 13 LXC template is available on the Proxmox host
		const ostemplate = 'local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst';
		const templateFile = '/var/lib/vz/template/cache/debian-13-standard_13.1-2_amd64.tar.zst';
		const sshCheck = await connectToProxmox();
		try {
			const { stdout } = await sshCheck.execCommand(`test -f ${templateFile} && echo exists`);
			if (!stdout?.includes('exists')) {
				await sshCheck.execCommand(`pveam download local debian-13-standard_13.1-2_amd64.tar.zst`);
			}
		} finally {
			sshCheck.dispose();
		}

		await createContainer({
			vmid: camera.vmid,
			hostname,
			ostemplate,
			cameraName: camera.name,
			cameraIp: camera.ip,
			cameraType: camera.cameraType,
			memory: containerMemoryMb
		});
	}

	await startContainer(camera.vmid);

	const ssh = await connectToProxmox();
	try {
		await waitForContainerReady(ssh, camera.vmid);

		// Wait for DHCP IP assignment (may take a few seconds after container is ready)
		let containerIp = '';
		for (let i = 0; i < 15; i++) {
			const ipResult = await executeOnContainer(ssh, camera.vmid, 'hostname -I');
			containerIp = ipResult.stdout.trim().split(/\s+/)[0];
			if (containerIp && containerIp.startsWith('192.168.')) break;
			await new Promise(r => setTimeout(r, 2000));
		}
		if (!containerIp || !containerIp.startsWith('192.168.')) {
			throw new Error(`Container ${camera.vmid} hat keine IP erhalten (DHCP timeout)`);
		}

		// Update camera record
		db.update(cameras)
			.set({
				containerIp,
				status: CAMERA_STATUS.CONTAINER_CREATED,
				updatedAt: new Date().toISOString()
			})
			.where(eq(cameras.id, cameraId))
			.run();

		return { vmid: camera.vmid, containerIp, fromTemplate };
	} finally {
		ssh.dispose();
	}
}

/**
 * Installs nginx auth-proxy in the container (Loxone Intercom only).
 */
export async function configureNginx(cameraId: number): Promise<void> {
	const camera = getCameraById(cameraId);
	const ssh = await connectToProxmox();

	try {
		const nginxCmds = getNginxInstallCommands();
		for (const cmd of nginxCmds) {
			await executeOnContainer(ssh, camera.vmid, cmd);
		}

		const decryptedPassword = decrypt(camera.password);
		const nginxConfig = generateNginxConfig(camera.ip, camera.username, decryptedPassword);
		await pushFileToContainer(ssh, camera.vmid, nginxConfig, '/etc/nginx/nginx.conf');
		await executeOnContainer(ssh, camera.vmid, 'systemctl restart nginx');
	} finally {
		ssh.dispose();
	}
}

/**
 * Installs go2rtc in the container, deploys config and systemd unit, starts the service.
 */
export async function configureGo2rtc(cameraId: number, skipInstall = false): Promise<void> {
	const camera = getCameraById(cameraId);
	const ssh = await connectToProxmox();

	try {
		// Bambu A1 needs Node installed during this step so the exec:node ingestion
		// script can start (Phase 18 RESEARCH §Pitfall 5). Other paths keep the
		// pre-Phase-18 baseline (Node lands later via getOnvifInstallCommands).
		const isBambuA1 = camera.cameraType === 'bambu' && camera.model === 'A1';

		// Skip package installation if cloned from template (already has ffmpeg + go2rtc)
		if (!skipInstall) {
			const installCmds = getInstallCommands(isBambuA1);
			for (const cmd of installCmds) {
				await executeOnContainer(ssh, camera.vmid, cmd);
			}
		}

		// RTSP-auth creds for the go2rtc rtsp: block, when opted-in on the camera.
		// Mobotix/Loxone reuse the camera's own HTTP credentials; Bambu uses
		// serial_number as user + access_code as password (matches the flow the
		// user expects in Protect's adoption dialog).
		const rtspAuth = buildRtspAuth(camera);

		let yamlContent: string;

		if (camera.cameraType === 'bambu') {
			// Bambu: access code is the shared secret; stored in access_code,
			// not password. H2C/O1C2/H2D/X1C/P1S use rtspx://...:322 (TLS passthrough);
			// A1 has no RTSPS and uses JPEG-over-TLS:6000 via a Node ingestion
			// script deployed to /opt/ipcm/ (Phase 18 D-01 / D-02).
			const accessCode = camera.accessCode ? decrypt(camera.accessCode) : '';
			if (!accessCode) throw new Error('Bambu camera missing access_code');

			if (camera.model === 'A1') {
				// A1: deploy ingestion script to /opt/ipcm/ before writing go2rtc.yaml,
				// then emit the exec: yaml that spawns it (Phase 18 RESEARCH §Gap 3).
				// Resolve from process.cwd() (the systemd WorkingDirectory is the
				// app root — same directory that holds package.json and lxc-assets/).
				// Source-relative resolution breaks after SvelteKit build because
				// the compiled file lives in build/server/chunks/ (3 levels deep),
				// not src/lib/server/services/ (4 levels deep).
				const mjsContent = readFileSync(
					resolve(process.cwd(), 'lxc-assets/bambu-a1-camera.mjs'),
					'utf8'
				);
				const transcodeSh = readFileSync(
					resolve(process.cwd(), 'lxc-assets/a1-transcode.sh'),
					'utf8'
				);
				await executeOnContainer(ssh, camera.vmid, 'mkdir -p /opt/ipcm');
				await pushFileToContainer(
					ssh,
					camera.vmid,
					mjsContent,
					'/opt/ipcm/bambu-a1-camera.mjs'
				);
				await pushFileToContainer(
					ssh,
					camera.vmid,
					transcodeSh,
					'/opt/ipcm/a1-transcode.sh'
				);
				// Shell wrapper must be executable — pushFileToContainer uses mode 644.
				await executeOnContainer(
					ssh,
					camera.vmid,
					'chmod +x /opt/ipcm/a1-transcode.sh'
				);

				yamlContent = generateGo2rtcConfigBambuA1({
					streamName: camera.streamName,
					printerIp: camera.ip,
					accessCode,
					rtspAuth
				});
			} else {
				// H2C / O1C2 / H2D / X1C / P1S / null (pre-Phase-18 rows assume H2C):
				// existing RTSPS:322 path with rtspx:// (skips TLS verify on self-signed).
				yamlContent = generateGo2rtcConfigBambu({
					streamName: camera.streamName,
					printerIp: camera.ip,
					accessCode,
					rtspAuth
				});
			}
		} else if (camera.cameraType === 'loxone') {
			// Loxone: go2rtc reads from local nginx proxy
			yamlContent = generateGo2rtcConfigLoxone({
				streamName: camera.streamName,
				width: camera.width,
				height: camera.height,
				fps: camera.fps,
				bitrate: camera.bitrate,
				rtspAuth
			});
		} else {
			// Mobotix: go2rtc reads directly from camera RTSP
			const decryptedPassword = decrypt(camera.password);
			yamlContent = generateGo2rtcConfig({
				streamName: camera.streamName,
				cameraIp: camera.ip,
				username: camera.username,
				password: decryptedPassword,
				width: camera.width,
				height: camera.height,
				fps: camera.fps,
				bitrate: camera.bitrate,
				streamPath: camera.streamPath,
				rtspAuth
			});
		}

		await pushFileToContainer(ssh, camera.vmid, yamlContent, '/etc/go2rtc/go2rtc.yaml');

		// Phase 18 / CR-02: Bambu go2rtc.yaml carries the decrypted access code
		// in two places (exec env var + rtsp password block). pushFileToContainer
		// leaves files at mode 644, so any non-root process inside the LXC could
		// read it. Lock to 600. The container is minimal-privilege (root + go2rtc
		// systemd unit runs as root), so 600 keeps the secret on disk without
		// breaking the service. Mobotix/Loxone configs carry only the camera
		// password which is already exposed via the RTSP URL in the file — still
		// worth hardening as a follow-up but out of scope for this fix.
		if (camera.cameraType === 'bambu') {
			await executeOnContainer(ssh, camera.vmid, 'chmod 600 /etc/go2rtc/go2rtc.yaml');
		}

		const unitContent = generateSystemdUnit();
		await pushFileToContainer(ssh, camera.vmid, unitContent, '/etc/systemd/system/go2rtc.service');

		await executeOnContainer(ssh, camera.vmid, 'systemctl daemon-reload && systemctl enable go2rtc && systemctl restart go2rtc');

		db.update(cameras)
			.set({ status: CAMERA_STATUS.GO2RTC_CONFIGURED, updatedAt: new Date().toISOString() })
			.where(eq(cameras.id, cameraId))
			.run();
	} finally {
		ssh.dispose();
	}
}

/**
 * Installs ONVIF server in the container, generates config, patches device naming, starts service.
 */
export async function configureOnvif(cameraId: number, skipInstall = false): Promise<void> {
	const camera = getCameraById(cameraId);
	const ssh = await connectToProxmox();

	try {
		// Skip package installation if cloned from template (already has Node.js + onvif-server)
		if (!skipInstall) {
			const onvifCmds = getOnvifInstallCommands();
			for (const cmd of onvifCmds) {
				await executeOnContainer(ssh, camera.vmid, cmd);
			}
		}

		// Get container MAC address and generate UUID
		const macResult = await executeOnContainer(ssh, camera.vmid, "ip link show eth0 | grep ether | awk '{print $2}'");
		const mac = macResult.stdout.trim() || 'bc:24:11:00:00:01';
		const uuidResult = await executeOnContainer(ssh, camera.vmid, 'cat /proc/sys/kernel/random/uuid');
		const uuid = uuidResult.stdout.trim();

		// Patch onvif-server.js for UniFi Protect (Manufacturer, Model, ONVIF name)
		// IMPORTANT: ONVIF discovery name must NOT contain spaces (gets truncated by Protect)
		//
		// How Protect uses these fields:
		//   - ONVIF URI name (onvif://.../<NAME>) → initial discovery name shown in Protect
		//   - Manufacturer → "Hersteller" field in Protect device info
		//   - Model → "Modell" field in Protect device info
		//   - After adoption, Protect uses Manufacturer as display name prefix
		//
		// How Protect maps ONVIF fields (verified empirically):
		//   Protect "Name" (display) = Manufacturer + " " + Model
		//   Protect "Model" (device info) = ONVIF URI name (onvif://.../<VALUE>)
		//   Protect "type" / "marketName" = ONVIF URI name
		//
		// Goal: Name="Terrasse", Model="MobotixS15D" in Protect UI
		//   → Manufacturer="Terrasse", Model="" (empty), URI="MobotixS15D"
		const safeName = camera.name
			.replace(/[Ää]/g, 'ae').replace(/[Öö]/g, 'oe').replace(/[Üü]/g, 'ue').replace(/ß/g, 'ss')
			.replace(/[^a-zA-Z0-9]/g, '');
		const isLoxone = camera.cameraType === 'loxone';
		const isBambu = camera.cameraType === 'bambu';
		const manufacturer = safeName; // Becomes the display name in Protect
		const model = ''; // Empty — otherwise appended to display name

		// Detect real camera model (e.g. "MOBOTIX S15D-Sec" → "MobotixS15D")
		let onvifName = 'GenericCamera';
		if (isLoxone) {
			onvifName = `Loxone${safeName}`;
		} else if (isBambu) {
			// Bambu H2C reports DevModel=O1C2 in SSDP (field-notes ground truth)
			onvifName = 'BambuLabH2C';
		} else {
			try {
				const pw = decrypt(camera.password);
				const versionResult = await ssh.execCommand(
					`curl -s --basic -u "${camera.username}:${pw}" "http://${camera.ip}/admin/version" --max-time 3`
				);
				const tdMatches = (versionResult.stdout || '').match(/<td[^>]*>(.*?)<\/td>/gs) || [];
				const tdTexts = tdMatches.map((td: string) => td.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
				if (tdTexts.length > 0 && tdTexts[0].includes('MOBOTIX')) {
					// "MOBOTIX S15D-Sec" → "MobotixS15D"
					const rawModel = tdTexts[0]; // e.g. "MOBOTIX S15D-Sec"
					const modelMatch = rawModel.match(/MOBOTIX\s+(\S+)/);
					if (modelMatch) {
						const shortModel = modelMatch[1].replace(/-.*$/, ''); // "S15D-Sec" → "S15D"
						onvifName = `Mobotix${shortModel}`; // "MobotixS15D" — no spaces!
					}
				}
			} catch { /* fallback to MobotixS15 */ }
		}
		// Use regex patterns so sed works on both fresh installs (Cardinal placeholders)
		// AND cloned templates (which already have the previous camera's values)
		await executeOnContainer(ssh, camera.vmid,
			`sed -i "s/[A-Za-z0-9]*HqCameraConfiguration/${safeName}HqCameraConfiguration/g; s/[A-Za-z0-9]*LqCameraConfiguration/${safeName}LqCameraConfiguration/g; s/Manufacturer: '[^']*'/Manufacturer: '${manufacturer}'/g; s/Model: '[^']*'/Model: '${model}'/g; s|onvif://www.onvif.org/name/[A-Za-z0-9]*|onvif://www.onvif.org/name/${onvifName}|g" /root/onvif-server/src/onvif-server.js`
		);

		// Patch ONVIF server to advertise audio (G.711 mulaw) — only for Mobotix (has audio on RTSP)
		// Loxone Intercom and Bambu H2C have no audio stream, so we skip the audio patch
		if (!isLoxone && !isBambu) {
			await pushFileToContainer(ssh, camera.vmid, getOnvifAudioPatch(), '/tmp/patch-onvif-audio.js');
			await executeOnContainer(ssh, camera.vmid, 'node /tmp/patch-onvif-audio.js');
		}

		// Replace node-soap's broken WSDL handling with a custom SOAP responder.
		// Without this patch, Protect's adoption SOAP calls get 500 responses
		// and credential validation fails. Safe for all camera types.
		await pushFileToContainer(ssh, camera.vmid, getOnvifSoapPatch(), '/tmp/patch-onvif-soap.js');
		await executeOnContainer(ssh, camera.vmid, 'node /tmp/patch-onvif-soap.js');

		// Generate and push ONVIF config
		const onvifConfig = generateOnvifConfig({
			streamName: camera.streamName,
			cameraName: camera.name,
			mac,
			uuid,
			width: camera.width,
			height: camera.height,
			fps: camera.fps,
			bitrate: camera.bitrate
		});
		await pushFileToContainer(ssh, camera.vmid, onvifConfig, '/root/onvif-server/config.yaml');

		// Push MAC auto-update script (runs before ONVIF server starts)
		const updateMacScript = `#!/bin/bash
MAC=$(ip link show eth0 | grep ether | awk '{print $2}')
sed -i "s/mac: .*/mac: $MAC/" /root/onvif-server/config.yaml
`;
		await pushFileToContainer(ssh, camera.vmid, updateMacScript, '/root/onvif-server/update-mac.sh');
		await executeOnContainer(ssh, camera.vmid, 'chmod +x /root/onvif-server/update-mac.sh');

		// Generate and push ONVIF systemd unit
		const onvifUnit = generateOnvifSystemdUnit();
		await pushFileToContainer(ssh, camera.vmid, onvifUnit, '/etc/systemd/system/onvif-server.service');

		// Enable and start ONVIF server
		await executeOnContainer(ssh, camera.vmid, 'systemctl daemon-reload && systemctl enable onvif-server && systemctl restart onvif-server');

		// Update status
		db.update(cameras)
			.set({ status: CAMERA_STATUS.CONFIGURED, updatedAt: new Date().toISOString() })
			.where(eq(cameras.id, cameraId))
			.run();

		// Create template from this container if none exists yet (first onboarding)
		// Only after fresh install (not cloned from template)
		if (!skipInstall) {
			const existingTemplate = await getTemplateVmid();
			if (!existingTemplate) {
				console.log(`[template] Creating base template from container ${camera.vmid}...`);
				// Fire-and-forget — don't block the onboarding response
				createTemplateFromContainer(camera.vmid).catch(err =>
					console.error('[template] Failed to create template:', err)
				);
			}
		}
	} finally {
		ssh.dispose();
	}
}

/**
 * Verifies the go2rtc stream is healthy via the HTTP API.
 */
export async function verifyStream(
	cameraId: number
): Promise<{ success: boolean; rtspUrl?: string; streamInfo: StreamInfo }> {
	const camera = getCameraById(cameraId);

	if (!camera.containerIp) {
		return {
			success: false,
			streamInfo: { active: false, codec: null, audioCodec: null, producers: 0, resolution: null }
		};
	}

	// Retry up to 6 times (30s total) — go2rtc/ONVIF may still be starting
	let streamInfo: StreamInfo = { active: false, codec: null, audioCodec: null, producers: 0, resolution: null };
	for (let attempt = 0; attempt < 6; attempt++) {
		streamInfo = await checkStreamHealth(camera.containerIp, camera.streamName);
		if (streamInfo.active) break;
		await new Promise(r => setTimeout(r, 5000));
	}

	if (streamInfo.active) {
		const rtspUrl = `rtsp://${camera.containerIp}:8554/${camera.streamName}`;

		db.update(cameras)
			.set({
				rtspUrl,
				status: CAMERA_STATUS.VERIFIED,
				updatedAt: new Date().toISOString()
			})
			.where(eq(cameras.id, cameraId))
			.run();

		return { success: true, rtspUrl, streamInfo };
	}

	return { success: false, streamInfo };
}

/**
 * Gets the next available VMID based on settings and existing cameras.
 */
export async function getNextVmid(): Promise<number> {
	// Auto-detect: find highest VMID on Proxmox, round up to next 1000, then increment
	try {
		const { listContainers } = await import('./proxmox');
		const containers = await listContainers();
		const allVmids = containers.map((c) => c.vmid);

		// Also include our DB entries
		const dbRows = db.select({ vmid: cameras.vmid }).from(cameras).all() as any[];
		for (const r of dbRows) {
			if (r.vmid > 0) allVmids.push(r.vmid);
		}

		// Also get VMs (not just LXC) to avoid conflicts with any Proxmox resource
		try {
			const { getProxmoxClient, getNodeName } = await import('./proxmox');
			const proxmox = await getProxmoxClient();
			const node = await getNodeName();
			const vms = await proxmox.nodes.$(node).qemu.$get() as any[];
			for (const vm of vms) {
				if (vm.vmid) allVmids.push(vm.vmid);
			}
		} catch { /* ignore — LXC list is enough */ }

		if (allVmids.length === 0) return 2000;

		const maxVmid = Math.max(...allVmids);
		// Our managed VMIDs start at 2000+. If none of ours exist yet,
		// round up to next 1000 boundary. Otherwise just increment.
		const ourVmids = allVmids.filter((v) => v >= 2000);
		let next: number;
		if (ourVmids.length === 0) {
			// First managed container: round up to next 1000
			next = Math.ceil((maxVmid + 1) / 1000) * 1000;
		} else {
			// Subsequent: just max + 1
			next = Math.max(...ourVmids) + 1;
		}
		// Skip any that are already in use
		const usedSet = new Set(allVmids);
		while (usedSet.has(next)) next++;
		return next;
	} catch {
		// Fallback if Proxmox unreachable
		const rows = db.select({ maxVmid: sql<number>`MAX(${cameras.vmid})` }).from(cameras).all();
		const maxVmid = rows[0]?.maxVmid || 0;
		return maxVmid > 0 ? maxVmid + 1 : 2000;
	}
}

/**
 * Helper to get a camera record by ID.
 */
function getCameraById(cameraId: number): Camera {
	const row = db.select().from(cameras).where(eq(cameras.id, cameraId)).get();
	if (!row) {
		throw new Error(`Camera with id ${cameraId} not found`);
	}
	return row as Camera;
}
