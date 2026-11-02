<script lang="ts">
	import { goto } from '$app/navigation';
	import StepIndicator from './StepIndicator.svelte';
	import StepCredentials from './StepCredentials.svelte';
	import StepBambuCredentials from './StepBambuCredentials.svelte';
	import StepBambuPreflight from './StepBambuPreflight.svelte';
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import { Loader2, CheckCircle, Camera, Pencil, Printer } from 'lucide-svelte';

	let {
		nextVmid,
		prefillIp = '',
		prefillUsername = '',
		prefillPassword = '',
		prefillName = '',
		cameraType = 'mobotix',
		prefillSerial = '',
		prefillModel = ''
	}: {
		nextVmid: number;
		prefillIp?: string;
		prefillUsername?: string;
		prefillPassword?: string;
		prefillName?: string;
		cameraType?: string;
		prefillSerial?: string;
		/** Phase 18: SSDP-discovered Bambu model (e.g. 'A1', 'O1C2'). Drives
		 * model-aware preflight + A1-specific wizard copy. */
		prefillModel?: string;
	} = $props();

	// ── Bambu branch state (parallel to the Mobotix/Loxone state below) ──
	let bambuIp = $state(prefillIp);
	let bambuSerial = $state(prefillSerial);
	let bambuAccessCode = $state('');
	let bambuModel = $state(prefillModel || 'H2C');
	let bambuStep = $state<'credentials' | 'preflight' | 'done'>('credentials');
	// Phase 18 / IN-02: Dedicated name state for the Bambu branch. Previously
	// the Mobotix-branch `name` leaked across if a user filled in the Mobotix
	// form, backed out, and switched to a Bambu flow. `bambuName` is seeded
	// from the same `prefillName` prop so discovery-matched names still land
	// on save-camera, but Mobotix keystrokes no longer pollute the Bambu body.
	let bambuName = $state(prefillName);

	function handleBambuCredentialsSubmit(result: {
		serialNumber: string;
		accessCode: string;
		model: string;
	}) {
		bambuSerial = result.serialNumber;
		bambuAccessCode = result.accessCode;
		bambuModel = result.model;
		bambuStep = 'preflight';
	}

	let bambuSaveError = $state<string | null>(null);
	let bambuSaving = $state(false);
	let bambuSaved = $state(false);
	let bambuProvisioning = $state(false);
	let bambuProvisioned = $state(false);
	let bambuProvisionError = $state<string | null>(null);

	async function handleBambuPreflightDone(ok: boolean) {
		if (!ok) {
			goto('/kameras');
			return;
		}
		bambuStep = 'done';
		bambuSaving = true;
		bambuSaveError = null;
		let cameraId: number | null = null;
		try {
			const res = await fetch('/api/onboarding/bambu/save-camera', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// Phase 18 / IN-02: `bambuName` is the Bambu-branch state,
					// not the Mobotix-branch `name`. See $state declaration above.
					name: bambuName || `Bambu Lab ${bambuSerial.slice(-6)}`,
					ip: bambuIp,
					serialNumber: bambuSerial,
					accessCode: bambuAccessCode,
					model: bambuModel
				})
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				bambuSaveError = data.error ?? 'Unbekannter Fehler beim Speichern';
				return;
			}
			bambuSaved = true;
			cameraId = data.cameraId;
		} catch (err) {
			bambuSaveError = err instanceof Error ? err.message : String(err);
			return;
		} finally {
			bambuSaving = false;
		}

		if (!cameraId) return;
		bambuProvisioning = true;
		bambuProvisionError = null;
		try {
			const res = await fetch('/api/onboarding/bambu/provision', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cameraId })
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				bambuProvisionError = data.error ?? 'LXC-Provisionierung fehlgeschlagen';
				return;
			}
			bambuProvisioned = true;
		} catch (err) {
			bambuProvisionError = err instanceof Error ? err.message : String(err);
		} finally {
			bambuProvisioning = false;
		}
	}

	function handleBambuPreflightRetry() {
		bambuStep = 'credentials';
	}

	// Wizard state
	let currentStep = $state(0);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let cameraId = $state<number | null>(null);
	let credentialsMatched = $derived(!!(prefillUsername && prefillPassword));

	// Auto-start if credentials AND name are pre-filled (matched from presets)
	// Don't auto-submit without a name — let the user enter it first
	$effect(() => {
		if (credentialsMatched && prefillName && prefillIp && currentStep === 0 && !loading && !cameraId) {
			handleCredentialsSubmit();
		}
	});

	// Form data
	let ip = $state(prefillIp);
	let username = $state(prefillUsername);
	let password = $state(prefillPassword);
	let name = $state(prefillName);

	// Transcode params (auto-detected)
	let width = $state(1280);
	let height = $state(720);
	let fps = $state(20);
	let bitrate = $state(2000);

	// Name editing
	let editingName = $state(false);

	// Results
	let snapshotUrl = $state<string | null>(null);
	let connectionInfo = $state<string | null>(null);
	let containerIp = $state<string | null>(null);
	let containerVmid = $state<number | null>(null);
	let fromTemplate = $state(false);
	let rtspUrl = $state<string | null>(null);
	let streamName = $derived(`cam-${nextVmid}`);

	// Step log
	let stepLog = $state<{ step: number; label: string; detail: string; status: 'done' | 'active' | 'pending' }[]>([]);

	// Long-running fetch with 10 min timeout (ONVIF install can take 5-8 min on first run)
	function longFetch(url: string, body: any): Promise<Response> {
		return fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000)
		});
	}

	function addLog(step: number, label: string, detail: string, status: 'done' | 'active' | 'pending' = 'active') {
		const existing = stepLog.find(l => l.step === step);
		if (existing) {
			existing.detail = detail;
			existing.status = status;
			stepLog = [...stepLog];
		} else {
			stepLog = [...stepLog, { step, label, detail, status }];
		}
	}

	// Sub-log for granular progress within a step
	let subLog = $state<string[]>([]);
	let subLogQueue: string[] = [];
	let subLogTimer: ReturnType<typeof setInterval> | null = null;

	function addSubLog(msg: string) {
		subLogQueue.push(msg);
	}
	function flushSubLog() {
		// Show all queued messages immediately
		if (subLogQueue.length > 0) {
			subLog = [...subLog, ...subLogQueue];
			subLogQueue = [];
		}
	}
	function startSubLogDrip() {
		// Drip-feed queued messages one by one with delay
		if (subLogTimer) clearInterval(subLogTimer);
		subLogTimer = setInterval(() => {
			if (subLogQueue.length > 0) {
				subLog = [...subLog, subLogQueue.shift()!];
			}
		}, 400);
	}
	function clearSubLog() {
		subLog = [];
		subLogQueue = [];
		if (subLogTimer) { clearInterval(subLogTimer); subLogTimer = null; }
	}

	// Auto-scroll sub-log to bottom
	$effect(() => {
		if (subLog.length > 0) {
			setTimeout(() => {
				const el = document.getElementById('sublog');
				if (el) el.scrollTop = el.scrollHeight;
			}, 50);
		}
	});

	// Load snapshot from camera
	async function loadSnapshot() {
		if (!ip || !username || !password) return;
		// For Loxone: use the camera ID snapshot endpoint (handles ffmpeg grab)
		// For Mobotix: use the onboarding snapshot endpoint
		if (cameraType === 'loxone' && cameraId) {
			try {
				const res = await fetch(`/api/cameras/${cameraId}/snapshot`);
				if (res.ok) {
					const blob = await res.blob();
					if (blob.size > 500) snapshotUrl = URL.createObjectURL(blob);
				}
			} catch { /* optional */ }
		} else {
			try {
				const res = await fetch('/api/onboarding/snapshot', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ip, username, password, cameraType })
				});
				if (res.ok) {
					const blob = await res.blob();
					snapshotUrl = URL.createObjectURL(blob);
				}
			} catch { /* optional */ }
		}
	}

	// Step 0: Save camera
	async function handleCredentialsSubmit() {
		if (!ip) {
			error = 'Bitte eine Kamera-IP eingeben';
			return;
		}
		// Auto-fetch saved credentials if user left fields empty
		if (!username || !password) {
			try {
				const credRes = await fetch('/api/credentials/test', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ip, cameraType })
				});
				if (credRes.ok) {
					const credData = await credRes.json();
					if (credData.success) {
						username = credData.username;
						password = credData.password;
					}
				}
			} catch { /* ignore */ }
		}
		if (!username || !password) {
			error = 'Keine Zugangsdaten gefunden — bitte Benutzername und Passwort eingeben';
			return;
		}
		// Auto-generate name if empty
		if (!name && ip) {
			const lastOctet = ip.split('.').pop();
			name = cameraType === 'loxone' ? `Intercom` : `Kamera-${lastOctet}`;
		}
		loading = true;
		error = null;

		try {
			const res = await fetch('/api/onboarding/save-camera', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, ip, username, password, width, height, fps, bitrate, vmid: nextVmid, cameraType })
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Kamera konnte nicht gespeichert werden');
			cameraId = data.cameraId;

			// Start automated pipeline
			currentStep = 1;
			await runStep1_TestConnection();
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			loading = false;
		}
	}

	// Step 1: Test connection
	let canSkipTest = $state(false);

	async function skipConnectionTest() {
		canSkipTest = false;
		addSubLog(`Verbindungstest übersprungen — verwende Standardwerte`);
		connectionInfo = `${width}x${height} @ ${fps}fps, ${bitrate} kbit/s (Standard)`;
		addLog(1, 'Verbindung testen', `Übersprungen — ${connectionInfo}`, 'done');
		error = null;
		loading = true;
		await runStep2_CreateContainer();
	}

	async function runStep1_TestConnection() {
		currentStep = 1;
		error = null;
		canSkipTest = false;
		clearSubLog();
		addLog(1, 'Verbindung testen', 'Starte Verbindungstest...', 'active');
		addSubLog(`SSH-Verbindung zum Proxmox-Host wird aufgebaut...`);
		addSubLog(`Teste RTSP-Zugang: rtsp://${username}:***@${ip}:554/stream0/mobotix.mjpeg`);
		startSubLogDrip();

		try {
			const res = await fetch('/api/onboarding/test-connection', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ip, username, password, cameraType })
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Verbindungstest fehlgeschlagen');

			if (data.resolution) {
				const parts = data.resolution.split('x');
				if (parts.length === 2) { width = parseInt(parts[0]) || width; height = parseInt(parts[1]) || height; }
				addSubLog(`Kamera-Auflösung erkannt: ${data.resolution}`);
			}
			if (data.fps) {
				fps = data.fps;
				addSubLog(`Kamera-Framerate erkannt: ${fps} fps (aus Mobotix framerate100)`);
			}
			const pixels = width * height;
			bitrate = Math.max(1000, Math.min(Math.round((pixels * fps * 0.1) / 1000 / 500) * 500, 10000));
			addSubLog(`Bitrate berechnet: ${bitrate} kbit/s (${width}x${height} x ${fps}fps x 0.1bpp)`);
			addSubLog(`Stream-Pfad: ${data.streamPath || '/stream0/mobotix.mjpeg'}`);

			connectionInfo = `${width}x${height} @ ${fps}fps, ${bitrate} kbit/s`;
			addLog(1, 'Verbindung testen', `Kamera erreichbar — ${connectionInfo}`, 'done');

			const snapshotPath = cameraType === 'loxone' ? '/mjpg/video.mjpg' : '/record/current.jpg';
			addSubLog(`Lade Vorschaubild von http://${ip}${snapshotPath} ...`);
			loadSnapshot();
			await new Promise(r => setTimeout(r, 3000));

			await runStep2_CreateContainer();
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			canSkipTest = true;
			addLog(1, 'Verbindung testen', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 2: Create container
	async function runStep2_CreateContainer() {
		currentStep = 2;
		error = null;
		clearSubLog();
		const hostname = `cam-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
		addLog(2, 'Container erstellen', `LXC ${nextVmid} wird auf Proxmox erstellt...`, 'active');
		startSubLogDrip();
		addSubLog(`Proxmox API: POST /nodes/pve/lxc`);
		addSubLog(`VMID: ${nextVmid}, Hostname: ${hostname}`);
		addSubLog(`Template: debian-12-standard_12.12-1_amd64.tar.zst`);
		addSubLog(`RAM: 192 MB, Disk: 4 GB, CPU: 1 Core`);
		addSubLog(`Network: vmbr0 (DHCP)`);
		addSubLog(`VAAPI Passthrough: /dev/dri/renderD128 (via SSH pct set)`);

		try {
			const res = await longFetch('/api/onboarding/create-container', { cameraId });
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Container konnte nicht erstellt werden');
			containerIp = data.containerIp;
			containerVmid = data.vmid;
			fromTemplate = data.fromTemplate === true;

			addSubLog(`Container gestartet, DHCP-IP erhalten: ${containerIp}`);
			if (fromTemplate) addSubLog(`Erstellt aus Template (Schnellmodus)`);

			addLog(2, 'Container erstellen', `LXC ${data.vmid} erstellt — ${hostname} @ ${containerIp}`, 'done');

			if (cameraType === 'loxone') {
				await runStep3_ConfigureNginx();
			} else {
				await runStep3_ConfigureGo2rtc();
			}
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(2, 'Container erstellen', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 3 (Loxone only): Configure nginx auth-proxy
	async function runStep3_ConfigureNginx() {
		currentStep = 3;
		error = null;
		clearSubLog();
		addLog(3, 'nginx Reverse Proxy', 'nginx wird installiert und konfiguriert...', 'active');
		startSubLogDrip();
		addSubLog(`apt-get install -y nginx`);
		addSubLog(`nginx.conf generieren:`);
		addSubLog(`  listen 127.0.0.1:8081`);
		addSubLog(`  proxy_pass http://${ip}/mjpg/`);
		addSubLog(`  Authorization: Basic header einbetten (${username}:***)`);
		addSubLog(`  proxy_buffering off (wichtig für MJPEG-Streams)`);
		addSubLog(`  proxy_http_version 1.1`);
		addSubLog(`Config schreiben: /etc/nginx/nginx.conf`);
		addSubLog(`systemctl restart nginx`);
		addSubLog(`Ergebnis: http://localhost:8081/mjpg/video.mjpg (ohne Auth)`);

		try {
			const res = await longFetch('/api/onboarding/configure-nginx', { cameraId });
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'nginx Konfiguration fehlgeschlagen');

			flushSubLog();
			addSubLog(`nginx läuft auf Port 8081 — Auth-Stripping aktiv`);
			addLog(3, 'nginx Reverse Proxy', `nginx läuft — strippt Auth für ${ip}`, 'done');
			await runStep4_ConfigureGo2rtcLoxone();
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(3, 'nginx Reverse Proxy', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 4 (Loxone): Configure go2rtc (reads from nginx)
	async function runStep4_ConfigureGo2rtcLoxone() {
		currentStep = 4;
		error = null;
		clearSubLog();
		addLog(4, 'go2rtc konfigurieren', 'Installiere ffmpeg + go2rtc im Container...', 'active');
		startSubLogDrip();
		addSubLog(`pct exec ${containerVmid} -- apt-get install -y ffmpeg wget`);
		addSubLog(`go2rtc Binary von github.com/AlexxIT/go2rtc herunterladen...`);
		addSubLog(`go2rtc.yaml generieren:`);
		addSubLog(`  Stream: ${streamName}`);
		addSubLog(`  Source: http://localhost:8081/mjpg/video.mjpg (via nginx)`);
		addSubLog(`  Transcode: MJPEG → H.264, ${width}x${height}@${fps}fps, ${bitrate}k`);
		addSubLog(`  Hardware: VAAPI (Intel /dev/dri/renderD128)`);
		addSubLog(`Config schreiben: /etc/go2rtc/go2rtc.yaml`);
		addSubLog(`systemd Unit: /etc/systemd/system/go2rtc.service`);
		addSubLog(`systemctl daemon-reload && enable && restart go2rtc`);

		try {
			const res = await longFetch('/api/onboarding/configure-go2rtc', { cameraId, skipInstall: fromTemplate });
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'go2rtc Konfiguration fehlgeschlagen');

			flushSubLog();
			addSubLog(`go2rtc Service läuft auf Port 8554 (RTSP) + 1984 (HTTP/WebRTC)`);
			addLog(4, 'go2rtc konfigurieren', `go2rtc läuft — liest von nginx @ localhost:8081`, 'done');
			await runStep5_ConfigureOnvifLoxone();
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(4, 'go2rtc konfigurieren', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 5 (Loxone): Configure ONVIF
	async function runStep5_ConfigureOnvifLoxone() {
		currentStep = 5;
		error = null;
		clearSubLog();
		const safeName = name.replace(/[^a-zA-Z0-9]/g, '');
		addLog(5, 'ONVIF Server', 'Node.js + ONVIF Server werden installiert...', 'active');
		startSubLogDrip();
		addSubLog(`Node.js 22 LTS installieren`);
		addSubLog(`git clone github.com/daniela-hase/onvif-server`);
		addSubLog(`npm install --production`);
		addSubLog(`onvif-server.js patchen: Manufacturer → "${safeName}", Model → "Loxone"`);
		addSubLog(`config.yaml generieren mit MAC, UUID, Stream-Mapping`);
		addSubLog(`systemd Unit anlegen + starten`);

		try {
			const res = await longFetch('/api/onboarding/configure-onvif', { cameraId, skipInstall: fromTemplate });
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'ONVIF Konfiguration fehlgeschlagen');

			flushSubLog();
			addSubLog(`ONVIF Server läuft auf Port 8899`);
			addLog(5, 'ONVIF Server', `ONVIF läuft — "${safeName}" @ ${containerIp}:8899`, 'done');
			await runStep6_VerifyStreamLoxone();
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(5, 'ONVIF Server', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 6 (Loxone): Verify stream
	async function runStep6_VerifyStreamLoxone() {
		currentStep = 6;
		error = null;
		clearSubLog();
		addLog(6, 'Stream verifizieren', 'Prüfe ob alles läuft...', 'active');
		startSubLogDrip();
		addSubLog(`GET http://${containerIp}:1984/api/streams`);
		addSubLog(`Prüfe Stream "${streamName}" ...`);

		try {
			const res = await fetch('/api/onboarding/verify-stream', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cameraId })
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Stream-Verifikation fehlgeschlagen');
			rtspUrl = data.rtspUrl;

			flushSubLog();
			addSubLog(`Stream aktiv: Intercom → nginx → go2rtc → RTSP`);
			addSubLog(`RTSP-Output: ${rtspUrl}`);
			addSubLog(`ONVIF-Discovery aktiv für UniFi Protect`);
			addLog(6, 'Stream verifizieren', `Alles läuft — ${rtspUrl}`, 'done');
			loading = false;
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(6, 'Stream verifizieren', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 3 (Mobotix): Configure go2rtc
	async function runStep3_ConfigureGo2rtc() {
		currentStep = 3;
		error = null;
		clearSubLog();
		addLog(3, 'go2rtc konfigurieren', 'Installiere ffmpeg + go2rtc im Container...', 'active');
		startSubLogDrip();
		addSubLog(`pct exec ${containerVmid} -- apt-get update && apt-get install -y ffmpeg wget`);
		addSubLog(`go2rtc Binary von github.com/AlexxIT/go2rtc herunterladen...`);
		addSubLog(`/usr/local/bin/go2rtc installiert`);
		if (cameraType === 'loxone') {
			addSubLog(`nginx installieren (Reverse Proxy für Auth-Stripping)...`);
			addSubLog(`nginx.conf generieren:`);
			addSubLog(`  listen 127.0.0.1:8081`);
			addSubLog(`  proxy_pass http://${ip}/mjpg/`);
			addSubLog(`  Authorization: Basic (${username}:***) eingebettet`);
			addSubLog(`  proxy_buffering off`);
			addSubLog(`Config schreiben: /etc/nginx/nginx.conf`);
			addSubLog(`nginx neu starten...`);
			addSubLog(`go2rtc.yaml generieren:`);
			addSubLog(`  Stream: ${streamName}`);
			addSubLog(`  Source: http://localhost:8081/mjpg/video.mjpg (via nginx)`);
		} else {
			addSubLog(`go2rtc.yaml generieren (Dual-Source):`);
			addSubLog(`  Stream: ${streamName}`);
			addSubLog(`  Video: HTTP MJPEG (faststream.jpg) + reconnect`);
			addSubLog(`  Audio: RTSP passthrough (G.711 mulaw copy)`);
		}
		addSubLog(`  Transcode: MJPEG → H.264, ${width}x${height}@${fps}fps, ${bitrate}k`);
		if (cameraType !== 'loxone') {
			addSubLog(`  Audio: pcm_mulaw passthrough (kein Transcoding)`);
		} else {
			addSubLog(`  Audio: nicht verfügbar (Intercom hat keinen Audio-Stream)`);
		}
		addSubLog(`  Hardware: VAAPI (Intel /dev/dri/renderD128)`);
		addSubLog(`Config schreiben: /etc/go2rtc/go2rtc.yaml`);
		addSubLog(`systemd Unit: /etc/systemd/system/go2rtc.service`);
		addSubLog(`systemctl daemon-reload && enable && restart go2rtc`);

		try {
			const res = await longFetch('/api/onboarding/configure-go2rtc', { cameraId, skipInstall: fromTemplate });
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'go2rtc Konfiguration fehlgeschlagen');

			addSubLog(`go2rtc Service läuft auf Port 8554 (RTSP) + 1984 (HTTP/WebRTC)`);
			addLog(3, 'go2rtc konfigurieren', `go2rtc läuft — MJPEG → H.264 VAAPI @ ${containerIp}:8554`, 'done');
			await runStep4_ConfigureOnvif();
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(3, 'go2rtc konfigurieren', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 4: Configure ONVIF
	async function runStep4_ConfigureOnvif() {
		currentStep = 4;
		error = null;
		clearSubLog();
		const safeName = name.replace(/[^a-zA-Z0-9]/g, '');
		addLog(4, 'ONVIF Server', 'Node.js + ONVIF Server werden installiert...', 'active');
		startSubLogDrip();
		addSubLog(`Node.js 22 LTS installieren (curl deb.nodesource.com | bash)`);
		addSubLog(`git clone github.com/daniela-hase/onvif-server`);
		addSubLog(`npm install --production`);
		addSubLog(`MAC-Adresse auslesen: ip link show eth0`);
		addSubLog(`UUID generieren: /proc/sys/kernel/random/uuid`);
		addSubLog(`onvif-server.js patchen:`);
		addSubLog(`  Manufacturer: 'Onvif' → '${safeName}'`);
		addSubLog(`  Model: 'Cardinal' → 'Mobotix'`);
		addSubLog(`  ONVIF-Name: 'Cardinal' → 'MOBOTIXS15'`);
		if (cameraType !== 'loxone') {
			addSubLog(`Audio-Profil patchen (G.711 mulaw für UniFi Protect)`);
		}
		addSubLog(`config.yaml generieren:`);
		addSubLog(`  Stream: /${streamName} → localhost:8554`);
		addSubLog(`  Snapshot: /api/frame.jpeg?src=${streamName} → localhost:1984`);
		if (cameraType !== 'loxone') {
			addSubLog(`  Audio: G.711 mulaw, 8kHz, mono`);
		}
		addSubLog(`  ONVIF Port: 8899`);
		addSubLog(`systemd Unit: /etc/systemd/system/onvif-server.service`);
		addSubLog(`systemctl daemon-reload && enable && restart onvif-server`);

		try {
			const res = await longFetch('/api/onboarding/configure-onvif', { cameraId, skipInstall: fromTemplate });
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'ONVIF Konfiguration fehlgeschlagen');

			addSubLog(`ONVIF Server läuft auf Port 8899 — Discovery + Audio aktiv`);
			addLog(4, 'ONVIF Server', `ONVIF läuft — "${safeName}" @ ${containerIp}:8899 (mit Audio)`, 'done');
			await runStep5_VerifyStream();
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(4, 'ONVIF Server', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	// Step 5: Verify stream
	async function runStep5_VerifyStream() {
		currentStep = 5;
		error = null;
		clearSubLog();
		addLog(5, 'Stream verifizieren', 'Prüfe ob alles läuft...', 'active');
		startSubLogDrip();
		addSubLog(`GET http://${containerIp}:1984/api/streams`);
		addSubLog(`Prüfe Stream "${streamName}" ...`);
		addSubLog(`Erwarte: mindestens 1 Producer (ffmpeg/go2rtc)`);

		try {
			const res = await fetch('/api/onboarding/verify-stream', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cameraId })
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Stream-Verifikation fehlgeschlagen');
			rtspUrl = data.rtspUrl;

			addSubLog(`Stream aktiv: ${data.streamInfo?.producers || 1} Producer`);
			addSubLog(`Video: H.264 (VAAPI)`);
			if (cameraType !== 'loxone') {
				addSubLog(`Audio: G.711 mulaw (passthrough)`);
				addSubLog(`RTSP-Output: ${rtspUrl}`);
				addSubLog(`Kamera ist per ONVIF-Discovery in UniFi Protect auffindbar (mit Audio)`);
				addLog(5, 'Stream verifizieren', `H.264 + Audio — ${rtspUrl}`, 'done');
			} else {
				addSubLog(`Audio: nicht verfügbar`);
				addSubLog(`RTSP-Output: ${rtspUrl}`);
				addSubLog(`Kamera ist per ONVIF-Discovery in UniFi Protect auffindbar`);
				addLog(5, 'Stream verifizieren', `H.264 (Video only) — ${rtspUrl}`, 'done');
			}
			loading = false;
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
			addLog(5, 'Stream verifizieren', `Fehler: ${error}`, 'done');
			loading = false;
		}
	}

	function retryCurrentStep() {
		error = null;
		if (cameraType === 'loxone') {
			if (currentStep === 1) runStep1_TestConnection();
			else if (currentStep === 2) runStep2_CreateContainer();
			else if (currentStep === 3) runStep3_ConfigureNginx();
			else if (currentStep === 4) runStep4_ConfigureGo2rtcLoxone();
			else if (currentStep === 5) runStep5_ConfigureOnvifLoxone();
			else if (currentStep === 6) runStep6_VerifyStreamLoxone();
		} else {
			if (currentStep === 1) runStep1_TestConnection();
			else if (currentStep === 2) runStep2_CreateContainer();
			else if (currentStep === 3) runStep3_ConfigureGo2rtc();
			else if (currentStep === 4) runStep4_ConfigureOnvif();
			else if (currentStep === 5) runStep5_VerifyStream();
		}
	}
</script>

{#if cameraType === 'bambu'}
	<div class="max-w-3xl">
		<div class="flex items-center gap-2 mb-6">
			<Printer class="w-5 h-5 text-accent" />
			<h1 class="text-lg font-bold text-text-primary">Bambu Lab — Onboarding</h1>
		</div>
		<div class="bg-bg-card border border-border rounded-lg p-6">
			{#if bambuStep === 'credentials'}
				<StepBambuCredentials
					ip={bambuIp}
					prefillSerial={bambuSerial}
					prefillName={bambuName}
					model={bambuModel}
					onSubmit={handleBambuCredentialsSubmit}
				/>
			{:else if bambuStep === 'preflight'}
				<StepBambuPreflight
					ip={bambuIp}
					serialNumber={bambuSerial}
					accessCode={bambuAccessCode}
					model={bambuModel}
					onDone={handleBambuPreflightDone}
					onRetry={handleBambuPreflightRetry}
				/>
			{:else if bambuStep === 'done'}
				<div class="space-y-4">
					<div class="flex items-center gap-3">
						<CheckCircle class="w-6 h-6 text-green-400" />
						<span class="text-text-primary font-bold">Pre-Flight bestanden</span>
					</div>
					{#if bambuSaving}
						<p class="text-sm text-text-secondary">Speichere Kamera…</p>
					{:else if bambuSaveError}
						<p class="text-sm text-red-400">Speichern fehlgeschlagen: {bambuSaveError}</p>
					{:else if bambuProvisioning}
						<p class="text-sm text-text-secondary">
							Kamera gespeichert. LXC-Container wird bereitgestellt und go2rtc konfiguriert
							(ca. 15–30 Sekunden)…
						</p>
					{:else if bambuProvisionError}
						<p class="text-sm text-red-400">LXC-Provisionierung fehlgeschlagen: {bambuProvisionError}</p>
					{:else if bambuProvisioned}
						<p class="text-sm text-green-400">
							Fertig — LXC läuft, go2rtc-Stream live. Kamera erscheint jetzt in der
							Kameraübersicht.
						</p>
					{:else if bambuSaved}
						<p class="text-sm text-text-secondary">Kamera gespeichert…</p>
					{/if}
					<div class="flex justify-end">
						<button
							type="button"
							disabled={bambuSaving}
							onclick={() => goto('/kameras')}
							class="bg-accent text-white rounded-lg px-6 py-2 hover:bg-accent/90 transition-colors font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Zur Kameraübersicht
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
{:else}
<div class="max-w-3xl">
	<StepIndicator {currentStep} {cameraType} />

	<div class="flex flex-col lg:flex-row gap-4">
		<!-- Left: Snapshot (persistent during onboarding) -->
		{#if snapshotUrl || currentStep > 0}
			<div class="lg:w-72 shrink-0">
				<div class="bg-black rounded-lg overflow-hidden" style="aspect-ratio: 16/9;">
					{#if snapshotUrl}
						<img src={snapshotUrl} alt={name} class="w-full h-full object-contain" />
					{:else}
						<div class="w-full h-full flex items-center justify-center text-text-secondary/50">
							<Camera class="w-8 h-8" />
						</div>
					{/if}
				</div>
				{#if name || ip}
					<div class="mt-2 flex items-center gap-1.5">
						{#if editingName}
							<input
								type="text"
								bind:value={name}
								class="text-sm font-medium text-text-primary bg-bg-input border border-border rounded px-2 py-1 focus:border-accent focus:outline-none flex-1"
								placeholder="Kameraname"
								onkeydown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') editingName = false; }}
								onblur={() => editingName = false}
							/>
						{:else}
							<span class="text-sm font-medium text-text-primary">{name}</span>
							<button onclick={() => editingName = true} class="text-text-secondary hover:text-text-primary cursor-pointer">
								<Pencil class="w-3.5 h-3.5" />
							</button>
						{/if}
					</div>
					<p class="text-xs text-text-secondary font-mono mt-1">{ip}</p>
				{/if}
			</div>
		{/if}

		<!-- Right: Step content -->
		<div class="flex-1">
			<div class="bg-bg-card border border-border rounded-lg p-6">
				{#if error}
					<div class="mb-4">
						<InlineAlert type="error" message={error} />
						<div class="flex gap-2 mt-2">
							<button onclick={retryCurrentStep} class="bg-accent text-white rounded-lg px-4 py-2 text-sm hover:bg-accent/90 cursor-pointer">
								Erneut versuchen
							</button>
							{#if canSkipTest}
								<button onclick={skipConnectionTest} class="bg-bg-input text-text-secondary rounded-lg px-4 py-2 text-sm hover:bg-bg-card cursor-pointer">
									Überspringen (Standardwerte)
								</button>
							{/if}
						</div>
					</div>
				{/if}

				{#if currentStep === 0}
					<StepCredentials
						bind:ip
						bind:username
						bind:password
						bind:name
						bind:width
						bind:height
						bind:fps
						bind:bitrate
						onSubmit={handleCredentialsSubmit}
						{credentialsMatched}
					/>
				{:else}
					<!-- Step log -->
					<div class="space-y-3">
						{#each stepLog as log (log.step)}
							<div class="flex items-start gap-3">
								{#if log.status === 'done'}
									<CheckCircle class="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
								{:else}
									<Loader2 class="w-5 h-5 text-accent animate-spin shrink-0 mt-0.5" />
								{/if}
								<div class="flex-1 min-w-0">
									<span class="text-sm font-medium text-text-primary">{log.label}</span>
									<p class="text-xs text-text-secondary">{log.detail}</p>
								</div>
							</div>
						{/each}
					</div>

					<!-- Sub-log: animated task list with spinners -->
					{#if subLog.length > 0}
						<div class="mt-4 bg-bg-primary/50 rounded-lg p-3 max-h-[500px] overflow-y-auto" id="sublog">
							<div class="space-y-1.5">
								{#each subLog as line, i}
									<div class="flex items-start gap-2">
										{#if i < subLog.length - 1 || !loading}
											<span class="text-green-400 text-xs mt-0.5 shrink-0">&#10003;</span>
										{:else}
											<Loader2 class="w-3.5 h-3.5 text-accent animate-spin shrink-0 mt-px" />
										{/if}
										<p class="font-mono text-[11px] leading-relaxed {i === subLog.length - 1 && loading ? 'text-text-primary font-medium' : 'text-text-secondary/70'}">
											{line}
										</p>
									</div>
									<!-- Show progress bar for download lines -->
									{#if (line.includes('herunterladen') || line.includes('installieren') || line.includes('clone')) && i === subLog.length - 1 && loading}
										<div class="ml-5 mt-1">
											<div class="w-full h-1 bg-bg-input rounded-full overflow-hidden">
												<div class="h-full bg-accent rounded-full animate-pulse" style="width: 65%; animation: progress 2s ease-in-out infinite;"></div>
											</div>
										</div>
									{/if}
								{/each}
							</div>
						</div>
					{/if}

					<!-- Final result -->
					{#if rtspUrl && !loading && !error}
						<div class="mt-6 pt-4 border-t border-border">
							<div class="flex items-center gap-2 mb-3">
								<CheckCircle class="w-5 h-5 text-green-400" />
								<span class="text-text-primary font-bold">Einrichtung abgeschlossen</span>
							</div>
							<div class="bg-bg-primary rounded-lg px-3 py-2 mb-4">
								<span class="text-xs text-text-secondary">RTSP</span>
								<code class="text-xs text-text-primary font-mono ml-2">{rtspUrl}</code>
							</div>
							<p class="text-xs text-text-secondary mb-4">Die Kamera ist jetzt per ONVIF in UniFi Protect auffindbar.</p>
							<button onclick={() => goto('/kameras')} class="bg-accent text-white rounded-lg px-6 py-2 hover:bg-accent/90 transition-colors font-medium cursor-pointer">
								Zur Kameraübersicht
							</button>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	</div>
</div>
{/if}
