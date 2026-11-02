<script lang="ts">
	import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte';
	import { Loader2, Wifi, Check, PlayCircle, XCircle, KeyRound, Copy, Printer } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';

	let { data } = $props();

	let selectedIp = $state<string | null>(null);
	let selectedSerial = $state<string>('');
	// Phase 18: SSDP-captured Bambu model, passed through to the wizard so
	// preflight + save-camera see the correct model string.
	let selectedModel = $state<string>('');
	let discovered = $state<{
		ip: string;
		type: 'mobotix' | 'mobotix-onvif' | 'loxone' | 'bambu' | 'unknown';
		alreadyOnboarded: boolean;
		name: string | null;
		serialNumber?: string;
		model?: string;
		lanModeHint?: string;
	}[]>([]);
	// Manual-add device-type selector (shown above the default wizard)
	let manualDeviceType = $state<'mobotix' | 'loxone' | 'bambu'>('mobotix');
	let manualBambuIp = $state('');
	let scanning = $state(true);
	let discoveryThumbnails = $state<Map<string, string>>(new Map());

	// For ONVIF registration
	let registeringIp = $state<string | null>(null);
	let registerName = $state('');
	let registerUser = $state('');
	let registerPass = $state('');
	let registerError = $state<string | null>(null);
	let registerLoading = $state(false);

	// Batch mode
	interface BatchSubStep {
		label: string;
		status: 'pending' | 'active' | 'done';
	}
	interface BatchStep {
		label: string;
		status: 'pending' | 'active' | 'done' | 'error';
		detail?: string;
		subs: BatchSubStep[];
	}
	interface BatchCamera {
		ip: string;
		name: string;
		type: string;
		status: 'pending' | 'active' | 'done' | 'error' | 'skipped';
		error?: string;
		steps: BatchStep[];
		expanded: boolean;
		snapshotUrl?: string | null;
		containerIp?: string;
	}
	let batchMode = $state(false);
	let batchCancelled = $state(false);
	let batchCurrentIndex = $state(0);
	let batchResults = $state<BatchCamera[]>([]);
	let batchCurrentIp = $state<string | null>(null);
	let batchDoneCount = $derived(batchResults.filter(r => r.status === 'done').length);
	let batchErrorCount = $derived(batchResults.filter(r => r.status === 'error').length);
	let batchRunning = $derived(batchResults.some(r => r.status === 'active'));
	let autoRedirectSeconds = $state(0);
	let autoRedirectTimer: ReturnType<typeof setInterval> | null = null;

	// Copy-to-clipboard feedback for the prominent Container-IP row
	let copiedIp = $state<string | null>(null);
	async function copyContainerIp(ip: string) {
		try {
			await navigator.clipboard.writeText(ip);
			copiedIp = ip;
			setTimeout(() => { if (copiedIp === ip) copiedIp = null; }, 2000);
		} catch {
			// clipboard unavailable — silent fail is acceptable for a nice-to-have
		}
	}

	// Credential prompt during batch (pauses batch until user provides credentials)
	type BasicPrompt = {
		kind: 'basic';
		camIdx: number;
		ip: string;
		cameraType: string;
		resolve: (cred: { username: string; password: string } | null) => void;
	};
	type BambuPrompt = {
		kind: 'bambu';
		camIdx: number;
		ip: string;
		prefillSerial: string;
		resolve: (cred: { serialNumber: string; accessCode: string } | null) => void;
	};
	let credPrompt = $state<BasicPrompt | BambuPrompt | null>(null);
	let credPromptName = $state('');
	let credPromptUser = $state('');
	let credPromptPass = $state('');
	let credPromptSerial = $state('');
	let credPromptAccessCode = $state('');
	let credPromptSaving = $state(false);
	let credPromptError = $state<string | null>(null);

	/** Pause the batch and show credential input for a Mobotix/Loxone camera. */
	function promptForCredentials(camIdx: number, ip: string, cameraType: string): Promise<{ username: string; password: string } | null> {
		return new Promise((resolve) => {
			credPromptName = '';
			credPromptUser = '';
			credPromptPass = '';
			credPromptError = null;
			credPromptSaving = false;
			credPrompt = { kind: 'basic', camIdx, ip, cameraType, resolve };
		});
	}

	/** Pause the batch and show serial + access-code input for a Bambu printer. */
	function promptForBambuCredentials(camIdx: number, ip: string, prefillSerial: string): Promise<{ serialNumber: string; accessCode: string } | null> {
		return new Promise((resolve) => {
			credPromptName = '';
			credPromptSerial = prefillSerial || '';
			credPromptAccessCode = '';
			credPromptError = null;
			credPromptSaving = false;
			credPrompt = { kind: 'bambu', camIdx, ip, prefillSerial, resolve };
		});
	}

	async function submitCredPrompt() {
		if (!credPrompt) return;
		credPromptSaving = true;
		credPromptError = null;
		try {
			if (credPrompt.kind === 'bambu') {
				if (!credPromptSerial.trim() || credPromptAccessCode.length !== 8) {
					credPromptError = 'Seriennummer und 8-stelliger Access Code erforderlich';
					credPromptSaving = false;
					return;
				}
				if (credPromptName.trim()) {
					await fetch('/api/credentials', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							name: credPromptName.trim(),
							type: 'bambu',
							serialNumber: credPromptSerial.trim(),
							accessCode: credPromptAccessCode
						})
					});
				}
				credPrompt.resolve({ serialNumber: credPromptSerial.trim(), accessCode: credPromptAccessCode });
			} else {
				if (!credPromptUser || !credPromptPass) {
					credPromptError = 'Benutzername und Passwort erforderlich';
					credPromptSaving = false;
					return;
				}
				if (credPromptName.trim()) {
					await fetch('/api/credentials', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name: credPromptName.trim(), type: 'mobotix', username: credPromptUser, password: credPromptPass })
					});
				}
				credPrompt.resolve({ username: credPromptUser, password: credPromptPass });
			}
			credPrompt = null;
		} catch (err: any) {
			credPromptError = err.message || 'Fehler beim Speichern';
		} finally {
			credPromptSaving = false;
		}
	}

	function skipCredPrompt() {
		if (!credPrompt) return;
		credPrompt.resolve(null);
		credPrompt = null;
	}

	type BambuCredEntry = { id: number; name: string };
	type BambuCredLookup = {
		bySerial: Map<string, BambuCredEntry>;
		globals: BambuCredEntry[];
	};

	/**
	 * Load all saved Bambu credentials into two buckets:
	 *   - bySerial: printer-specific logins keyed by serial number
	 *   - globals: logins without a serial number — used as default for any
	 *     Bambu printer that has no per-serial match (same fallback the
	 *     StepBambuCredentials wizard uses in the single-camera flow).
	 */
	async function loadBambuCredMap(): Promise<BambuCredLookup> {
		const bySerial = new Map<string, BambuCredEntry>();
		const globals: BambuCredEntry[] = [];
		try {
			const res = await fetch('/api/credentials');
			if (!res.ok) return { bySerial, globals };
			const rows = (await res.json()) as Array<{ id: number; name: string; type: string; serialNumber?: string }>;
			for (const r of rows) {
				if (r.type !== 'bambu') continue;
				if (r.serialNumber) bySerial.set(r.serialNumber, { id: r.id, name: r.name });
				else globals.push({ id: r.id, name: r.name });
			}
		} catch { /* ignore */ }
		return { bySerial, globals };
	}

	async function fetchBambuCredentialById(id: number): Promise<{ serialNumber: string; accessCode: string } | null> {
		try {
			const res = await fetch(`/api/credentials/${id}`);
			if (!res.ok) return null;
			const data = await res.json();
			// Accept globals (no serial) too — caller supplies the SSDP-derived
			// serial. Only the accessCode is mandatory here.
			if (data.type !== 'bambu' || !data.accessCode) return null;
			return { serialNumber: data.serialNumber ?? '', accessCode: data.accessCode };
		} catch { return null; }
	}

	// Pipeline cameras that need the wizard
	let pipelineCameras = $derived(discovered.filter(c => c.type === 'mobotix' || c.type === 'loxone'));
	let onvifCameras = $derived(discovered.filter(c => c.type === 'mobotix-onvif'));
	let bambuCameras = $derived(discovered.filter(c => c.type === 'bambu'));

	async function runDiscovery() {
		scanning = true;
		discoveryThumbnails = new Map();
		try {
			const res = await fetch('/api/discovery?start=1&end=50');
			if (res.ok) {
				const data = await res.json();
				discovered = data.cameras.filter((c: any) => !c.alreadyOnboarded);
				// Fire-and-forget: load thumbnails in parallel after list renders
				loadDiscoveryThumbnails();
			}
		} catch { /* ignore */ }
		finally { scanning = false; }
	}

	function loadDiscoveryThumbnails() {
		for (const cam of discovered) {
			fetchCredentials(cam.ip, cam.type === 'mobotix-onvif' ? 'mobotix-onvif' : cam.type).then(async (cred) => {
				if (!cred.success) return;
				try {
					const res = await fetch('/api/onboarding/snapshot', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ ip: cam.ip, username: cred.username, password: cred.password, cameraType: cam.type }),
						signal: AbortSignal.timeout(15000)
					});
					if (res.ok) {
						const blob = await res.blob();
						if (blob.size > 500) {
							discoveryThumbnails = new Map(discoveryThumbnails).set(cam.ip, URL.createObjectURL(blob));
						}
					}
				} catch { /* optional */ }
			});
		}
	}

	$effect(() => { runDiscovery(); });

	let prefillName = $state('');
	let selectedCameraType = $state('mobotix');
	let prefillUser = $state('');
	let prefillPass = $state('');
	let prefillCredName = $state('');

	async function fetchCredentials(ip: string, cameraType: string): Promise<{ success: boolean; username: string; password: string; name: string }> {
		try {
			const res = await fetch('/api/credentials/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ip, cameraType })
			});
			if (res.ok) {
				const data = await res.json();
				if (data.success) return data;
			}
		} catch { /* ignore */ }
		return { success: false, username: '', password: '', name: '' };
	}

	function resetRegisterForm() {
		registeringIp = null;
		registerName = '';
		registerUser = '';
		registerPass = '';
		registerError = null;
		registerLoading = false;
	}

	async function selectCamera(
		ip: string,
		name?: string | null,
		type?: string,
		serialNumber?: string,
		model?: string
	) {
		prefillName = name || '';
		selectedCameraType = type || 'mobotix';
		selectedSerial = serialNumber || '';
		selectedModel = model || '';
		if (selectedCameraType !== 'bambu') {
			const cred = await fetchCredentials(ip, selectedCameraType);
			if (cred.success) {
				prefillUser = cred.username;
				prefillPass = cred.password;
				prefillCredName = cred.name;
			}
		} else {
			// Bambu has its own credential shape (Serial + Access Code); no generic creds
			prefillUser = '';
			prefillPass = '';
			prefillCredName = '';
		}
		selectedIp = ip;
	}

	function startManualBambu() {
		if (!manualBambuIp.trim()) return;
		selectedCameraType = 'bambu';
		selectedSerial = '';
		prefillName = '';
		prefillUser = '';
		prefillPass = '';
		prefillCredName = '';
		selectedIp = manualBambuIp.trim();
	}

	async function startRegister(ip: string, name?: string | null) {
		registeringIp = ip;
		registerName = name || '';
		registerUser = '';
		registerPass = '';
		registerError = null;
		const cred = await fetchCredentials(ip, 'mobotix-onvif');
		if (cred.success) {
			registerUser = cred.username;
			registerPass = cred.password;
			if (registerName) {
				await submitRegister();
				return;
			}
		}
	}

	async function submitRegister() {
		if (!registerName || !registerUser || !registerPass || !registeringIp) {
			registerError = 'Bitte alle Felder ausfüllen';
			return;
		}
		registerLoading = true;
		registerError = null;
		try {
			const res = await fetch('/api/cameras/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: registerName,
					ip: registeringIp,
					username: registerUser,
					password: registerPass,
					cameraType: 'mobotix-onvif'
				})
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error);
			goto('/kameras');
		} catch (err: any) {
			registerError = err.message || 'Registrierung fehlgeschlagen';
		} finally {
			registerLoading = false;
		}
	}

	// ── Batch: Add All ──────────────────────────────

	function makePipelineSteps(type: string): BatchStep[] {
		const steps: BatchStep[] = [
			{ label: 'Zugangsdaten', status: 'pending', subs: [
				{ label: 'Gespeicherte Credentials prüfen', status: 'pending' },
				{ label: 'Login testen', status: 'pending' },
			]},
			{ label: 'Verbindungstest', status: 'pending', subs: [
				{ label: 'RTSP-Stream proben (ffprobe)', status: 'pending' },
				{ label: 'Auflösung + FPS erkennen', status: 'pending' },
				{ label: 'Vorschaubild laden', status: 'pending' },
			]},
			{ label: 'Container erstellen', status: 'pending', subs: [
				{ label: 'LXC auf Proxmox anlegen (Debian 12)', status: 'pending' },
				{ label: 'VAAPI Passthrough (/dev/dri)', status: 'pending' },
				{ label: 'Container starten + IP per DHCP', status: 'pending' },
			]},
			{ label: 'go2rtc', status: 'pending', subs: [
				{ label: 'go2rtc Binary herunterladen', status: 'pending' },
				{ label: 'YAML-Config generieren (MJPEG → H.264)', status: 'pending' },
				{ label: 'systemd Service starten', status: 'pending' },
			]},
		];
		if (type === 'loxone') steps.push({ label: 'nginx Proxy', status: 'pending', subs: [
			{ label: 'nginx installieren', status: 'pending' },
			{ label: 'Auth-Proxy Config generieren', status: 'pending' },
			{ label: 'nginx starten', status: 'pending' },
		]});
		steps.push({ label: 'ONVIF Server', status: 'pending', subs: [
			{ label: 'Node.js 22 LTS installieren', status: 'pending' },
			{ label: 'git clone onvif-server', status: 'pending' },
			{ label: 'npm install', status: 'pending' },
			{ label: 'MAC + UUID auslesen', status: 'pending' },
			{ label: 'Gerätename patchen', status: 'pending' },
			{ label: 'config.yaml generieren', status: 'pending' },
			{ label: 'systemd Service starten', status: 'pending' },
		]});
		steps.push({ label: 'Stream prüfen', status: 'pending', subs: [
			{ label: 'go2rtc API abfragen', status: 'pending' },
			{ label: 'RTSP-Stream verifizieren', status: 'pending' },
		]});
		return steps;
	}

	function makeOnvifSteps(): BatchStep[] {
		return [
			{ label: 'Zugangsdaten', status: 'pending', subs: [
				{ label: 'Gespeicherte Credentials prüfen', status: 'pending' },
			]},
			{ label: 'Registrieren', status: 'pending', subs: [
				{ label: 'In Datenbank speichern', status: 'pending' },
				{ label: 'Nativ ONVIF — kein Container nötig', status: 'pending' },
			]},
		];
	}

	function makeBambuSteps(): BatchStep[] {
		return [
			{ label: 'Zugangsdaten', status: 'pending', subs: [
				{ label: 'Gespeicherte Bambu-Logins prüfen', status: 'pending' },
				{ label: 'Seriennummer mit Access Code abgleichen', status: 'pending' },
			]},
			{ label: 'Kamera speichern', status: 'pending', subs: [
				{ label: 'Datensatz anlegen', status: 'pending' },
			]},
			{ label: 'LXC provisionieren', status: 'pending', subs: [
				{ label: 'Container aus Template klonen', status: 'pending' },
				{ label: 'go2rtc YAML generieren (RTSPS-Passthrough)', status: 'pending' },
				{ label: 'systemd Service starten', status: 'pending' },
			]},
		];
	}

	// Animate sub-steps while an API call is running
	let subStepTimer: ReturnType<typeof setInterval> | null = null;

	function startSubStepAnimation(camIdx: number, stepIdx: number) {
		stopSubStepAnimation();
		let subIdx = 0;
		const subs = batchResults[camIdx].steps[stepIdx].subs;
		if (subs.length === 0) return;
		subs[0].status = 'active';

		subStepTimer = setInterval(() => {
			if (subIdx < subs.length && subs[subIdx].status === 'active') {
				subs[subIdx].status = 'done';
			}
			subIdx++;
			if (subIdx < subs.length) {
				subs[subIdx].status = 'active';
			} else {
				stopSubStepAnimation();
			}
		}, 2500); // tick every 2.5s
	}

	function stopSubStepAnimation() {
		if (subStepTimer) { clearInterval(subStepTimer); subStepTimer = null; }
	}

	function finishAllSubs(camIdx: number, stepIdx: number) {
		stopSubStepAnimation();
		for (const sub of batchResults[camIdx].steps[stepIdx].subs) {
			sub.status = 'done';
		}
	}

	function setStep(camIdx: number, stepIdx: number, status: BatchStep['status'], detail?: string) {
		if (status === 'active') {
			startSubStepAnimation(camIdx, stepIdx);
		} else if (status === 'done') {
			finishAllSubs(camIdx, stepIdx);
		}
		batchResults[camIdx].steps[stepIdx].status = status;
		if (detail) batchResults[camIdx].steps[stepIdx].detail = detail;
	}

	async function startBatch() {
		batchMode = true;
		batchCancelled = false;
		batchCurrentIndex = 0;

		batchResults = [
			...onvifCameras.map(c => ({ ip: c.ip, name: c.name || c.ip, type: c.type, status: 'pending' as const, steps: makeOnvifSteps(), expanded: false })),
			...pipelineCameras.map(c => ({ ip: c.ip, name: c.name || c.ip, type: c.type, status: 'pending' as const, steps: makePipelineSteps(c.type), expanded: false })),
			...bambuCameras.map(c => ({ ip: c.ip, name: c.name || c.ip, type: c.type, status: 'pending' as const, steps: makeBambuSteps(), expanded: false }))
		];

		// Pre-load all snapshots in parallel (fire-and-forget, fills thumbnails while queue runs)
		// Skip for Bambu — snapshots come from go2rtc after container provisioning.
		for (let i = 0; i < batchResults.length; i++) {
			const cam = batchResults[i];
			if (cam.type === 'bambu') continue;
			fetchCredentials(cam.ip, cam.type === 'mobotix-onvif' ? 'mobotix-onvif' : cam.type).then(async (cred) => {
				if (!cred.success) return;
				try {
					const res = await fetch('/api/onboarding/snapshot', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ ip: cam.ip, username: cred.username, password: cred.password, cameraType: cam.type }),
						signal: AbortSignal.timeout(15000)
					});
					if (res.ok) {
						const blob = await res.blob();
						if (blob.size > 500) batchResults[i].snapshotUrl = URL.createObjectURL(blob);
					}
				} catch { /* optional */ }
			});
		}

		// Load saved Bambu credentials once for the whole batch run.
		const bambuCredLookup = await loadBambuCredMap();

		for (let i = 0; i < batchResults.length; i++) {
			if (batchCancelled) {
				for (let j = i; j < batchResults.length; j++) batchResults[j].status = 'skipped';
				break;
			}

			batchCurrentIndex = i;
			batchResults[i].status = 'active';
			batchResults[i].expanded = true;
			batchCurrentIp = batchResults[i].ip;
			await scrollToCamera(i);
			const cam = discovered.find(c => c.ip === batchResults[i].ip);

			try {
				if (cam?.type === 'mobotix-onvif') {
					await batchRegisterOnvif(i, cam);
				} else if (cam?.type === 'bambu') {
					await batchOnboardBambu(i, cam, bambuCredLookup);
				} else {
					await batchOnboardPipeline(i, cam!);
				}
				batchResults[i].status = 'done';
				batchResults[i].expanded = false;
			} catch (err: any) {
				batchResults[i].status = 'error';
				batchResults[i].error = err.message || 'Unbekannter Fehler';
				// Mark current step as error
				const activeStep = batchResults[i].steps.findIndex(s => s.status === 'active');
				if (activeStep >= 0) batchResults[i].steps[activeStep].status = 'error';
			}
		}

		batchCurrentIp = null;

		// Auto-redirect countdown (10s)
		autoRedirectSeconds = 10;
		autoRedirectTimer = setInterval(() => {
			autoRedirectSeconds--;
			if (autoRedirectSeconds <= 0) {
				if (autoRedirectTimer) clearInterval(autoRedirectTimer);
				goto('/kameras');
			}
		}, 1000);
	}

	function cancelBatch() {
		batchCancelled = true;
		if (autoRedirectTimer) { clearInterval(autoRedirectTimer); autoRedirectTimer = null; }
		autoRedirectSeconds = 0;
	}

	async function scrollToCamera(idx: number) {
		await tick();
		const el = document.getElementById(`batch-cam-${idx}`);
		el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	// Auto-scroll when step changes
	function setStepAndScroll(camIdx: number, stepIdx: number, status: BatchStep['status'], detail?: string) {
		setStep(camIdx, stepIdx, status, detail);
		if (status === 'active') scrollToCamera(camIdx);
	}

	async function batchRegisterOnvif(idx: number, cam: { ip: string; name: string | null; type: string }) {
		// Step 0: Credentials
		setStep(idx, 0, 'active');
		let cred = await fetchCredentials(cam.ip, 'mobotix-onvif');
		let username: string, password: string;
		if (cred.success) {
			username = cred.username;
			password = cred.password;
		} else {
			const manual = await promptForCredentials(idx, cam.ip, 'mobotix-onvif');
			if (!manual) throw new Error('Übersprungen — keine Zugangsdaten');
			username = manual.username;
			password = manual.password;
		}
		setStep(idx, 0, 'done', username);

		// Step 1: Register
		setStep(idx, 1, 'active');
		const res = await fetch('/api/cameras/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: cam.name || cam.ip, ip: cam.ip, username, password, cameraType: 'mobotix-onvif' })
		});
		const d = await res.json();
		if (!d.success) throw new Error(d.error || 'Registrierung fehlgeschlagen');
		setStep(idx, 1, 'done', 'Nativ ONVIF — kein Container');
	}

	async function batchOnboardPipeline(idx: number, cam: { ip: string; name: string | null; type: string }) {
		let stepNum = 0;
		const isLoxone = cam.type === 'loxone';

		// Step 0: Credentials
		setStep(idx, stepNum, 'active');
		let cred = await fetchCredentials(cam.ip, cam.type);
		let username: string, password: string;
		if (cred.success) {
			username = cred.username;
			password = cred.password;
		} else {
			const manual = await promptForCredentials(idx, cam.ip, cam.type);
			if (!manual) throw new Error('Übersprungen — keine Zugangsdaten');
			username = manual.username;
			password = manual.password;
		}
		setStep(idx, stepNum, 'done', username);
		stepNum++;

		// Step 1: Test connection
		setStep(idx, stepNum, 'active');
		const testRes = await fetch('/api/onboarding/test-connection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ip: cam.ip, username, password, cameraType: cam.type }),
			signal: AbortSignal.timeout(60000)
		});
		const testData = await testRes.json();
		if (!testData.success) throw new Error(testData.error || 'Verbindungstest fehlgeschlagen');
		setStep(idx, stepNum, 'done', `${testData.width || 1280}x${testData.height || 720} @ ${testData.fps || 20}fps`);
		stepNum++;

		// Snapshot already pre-loaded in parallel at batch start

		// Save camera
		// Phase 18 / WR-02: Require a fresh VMID from test-connection per camera.
		// The page-load `data.nextVmid + idx` fallback could collide on back-to-back
		// batches because pending batch cameras aren't yet in the DB when the second
		// page loads. Fail loudly rather than silently reuse a stale VMID.
		if (!testData.nextVmid) {
			throw new Error('VMID konnte nicht ermittelt werden — erneut versuchen');
		}
		const saveRes = await fetch('/api/onboarding/save-camera', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: cam.name || cam.ip, ip: cam.ip, username, password,
				width: testData.width || 1280, height: testData.height || 720,
				fps: testData.fps || 20, bitrate: testData.bitrate || 2000,
				vmid: testData.nextVmid, cameraType: cam.type
			}),
		});
		const saveData = await saveRes.json();
		if (!saveData.success) throw new Error(saveData.error || 'Speichern fehlgeschlagen');
		const cameraId = saveData.cameraId;

		// Step 2: Create container
		setStep(idx, stepNum, 'active');
		const createRes = await fetch('/api/onboarding/create-container', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cameraId }),
			signal: AbortSignal.timeout(120000)
		});
		const createData = await createRes.json();
		if (!createData.success) throw new Error(createData.error || 'Container fehlgeschlagen');
		batchResults[idx].containerIp = createData.containerIp;
		const skipInstall = createData.fromTemplate === true;
		setStep(idx, stepNum, 'done', `LXC ${createData.vmid} @ ${createData.containerIp}${skipInstall ? ' (Template)' : ''}`);
		stepNum++;

		// Step 3: go2rtc
		setStep(idx, stepNum, 'active');
		const g2rRes = await fetch('/api/onboarding/configure-go2rtc', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cameraId, skipInstall }),
			signal: AbortSignal.timeout(skipInstall ? 30000 : 120000)
		});
		const g2rData = await g2rRes.json();
		if (!g2rData.success) throw new Error(g2rData.error || 'go2rtc fehlgeschlagen');
		setStep(idx, stepNum, 'done', 'MJPEG → H.264 VAAPI');
		stepNum++;

		// Step 3b: nginx (Loxone)
		if (isLoxone) {
			setStep(idx, stepNum, 'active');
			const ngxRes = await fetch('/api/onboarding/configure-nginx', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cameraId }),
				signal: AbortSignal.timeout(120000)
			});
			const ngxData = await ngxRes.json();
			if (!ngxData.success) throw new Error(ngxData.error || 'nginx fehlgeschlagen');
			setStep(idx, stepNum, 'done', 'Auth-Proxy aktiv');
			stepNum++;
		}

		// Step 4: ONVIF
		setStep(idx, stepNum, 'active');
		const onvifRes = await fetch('/api/onboarding/configure-onvif', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cameraId, skipInstall }),
			signal: AbortSignal.timeout(skipInstall ? 30000 : 600000)
		});
		const onvifData = await onvifRes.json();
		if (!onvifData.success) throw new Error(onvifData.error || 'ONVIF fehlgeschlagen');
		setStep(idx, stepNum, 'done', 'Port 8899 aktiv');
		stepNum++;

		// Step 5: Verify
		setStep(idx, stepNum, 'active');
		const verRes = await fetch('/api/onboarding/verify-stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cameraId }),
			signal: AbortSignal.timeout(60000)
		});
		const verData = await verRes.json();
		if (!verData.success) throw new Error('Stream-Verifikation fehlgeschlagen');
		setStep(idx, stepNum, 'done', 'RTSP Stream OK');
	}

	/**
	 * Batch onboarding for a single Bambu printer.
	 * Matches saved credentials by serial number first; falls back to
	 * a Bambu-shaped credential prompt if no match. Uses the two
	 * Bambu-specific endpoints (save-camera + provision) — no
	 * test-connection/verify-stream roundtrips because go2rtc inside
	 * the container handles the RTSPS pull end-to-end.
	 */
	async function batchOnboardBambu(
		idx: number,
		cam: { ip: string; name: string | null; type: string; serialNumber?: string; model?: string },
		bambuCredLookup: BambuCredLookup
	) {
		let stepNum = 0;

		// Step 0: credentials — auto-match by serial, then unique global default, else prompt
		setStep(idx, stepNum, 'active');
		let serialNumber = (cam.serialNumber || '').trim();
		let accessCode = '';

		// Tier 1: serial-exact match (printer-specific saved login)
		if (serialNumber && bambuCredLookup.bySerial.has(serialNumber)) {
			const hit = bambuCredLookup.bySerial.get(serialNumber)!;
			const creds = await fetchBambuCredentialById(hit.id);
			if (creds && creds.accessCode) {
				// Saved credential's serial wins when present; otherwise keep
				// the SSDP-derived serial we already have.
				if (creds.serialNumber) serialNumber = creds.serialNumber;
				accessCode = creds.accessCode;
				setStep(idx, stepNum, 'done', `gespeichert: ${hit.name}`);
			}
		}

		// Tier 2a: global credential whose name matches the SSDP DevName
		// (case-insensitive). User-friendly path when multiple globals exist
		// — tag a credential "A1 Mini" and it binds to the SSDP-discovered
		// "A1 Mini" printer without needing the serial up-front.
		if (!accessCode && cam.name) {
			const target = cam.name.trim().toLowerCase();
			const nameMatch = bambuCredLookup.globals.find(
				(g) => g.name.trim().toLowerCase() === target
			);
			if (nameMatch) {
				const creds = await fetchBambuCredentialById(nameMatch.id);
				if (creds && creds.accessCode) {
					accessCode = creds.accessCode;
					setStep(idx, stepNum, 'done', `Name-Match: ${nameMatch.name}`);
				}
			}
		}

		// Tier 2b: unique serial-less global default (user's "apply to any Bambu")
		if (!accessCode && bambuCredLookup.globals.length === 1) {
			const hit = bambuCredLookup.globals[0];
			const creds = await fetchBambuCredentialById(hit.id);
			if (creds && creds.accessCode) {
				accessCode = creds.accessCode;
				setStep(idx, stepNum, 'done', `global: ${hit.name}`);
			}
		}

		// Tier 3: manual prompt
		if (!accessCode) {
			const manual = await promptForBambuCredentials(idx, cam.ip, serialNumber);
			if (!manual) throw new Error('Übersprungen — kein Access Code');
			serialNumber = manual.serialNumber;
			accessCode = manual.accessCode;
			setStep(idx, stepNum, 'done', `manuell (${serialNumber.slice(-6)})`);
		}

		stepNum++;

		// Step 1: save-camera row (Bambu-specific endpoint)
		setStep(idx, stepNum, 'active');
		const saveRes = await fetch('/api/onboarding/bambu/save-camera', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: cam.name || `Bambu Lab ${serialNumber.slice(-6)}`,
				ip: cam.ip,
				serialNumber,
				accessCode,
				model: cam.model ?? ''
			})
		});
		const saveData = await saveRes.json();
		if (!saveRes.ok || !saveData.success) {
			throw new Error(saveData.error || 'Speichern fehlgeschlagen');
		}
		const cameraId = saveData.cameraId;
		setStep(idx, stepNum, 'done', `ID ${cameraId}`);
		stepNum++;

		// Step 2: provision LXC + go2rtc (long-running, 4-5 min first time)
		setStep(idx, stepNum, 'active');
		const provisionRes = await fetch('/api/onboarding/bambu/provision', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cameraId }),
			signal: AbortSignal.timeout(300000)
		});
		const provisionData = await provisionRes.json();
		if (!provisionRes.ok || !provisionData.success) {
			throw new Error(provisionData.error || 'LXC-Provisionierung fehlgeschlagen');
		}
		if (provisionData.containerIp) batchResults[idx].containerIp = provisionData.containerIp;
		setStep(idx, stepNum, 'done', provisionData.containerIp ? `go2rtc @ ${provisionData.containerIp}` : 'fertig');
	}
</script>

<h1 class="text-2xl font-bold text-text-primary mb-6">Kamera einrichten</h1>

{#if batchMode}
	<!-- Batch Mode UI -->
	<div class="space-y-4">
		<!-- Header with progress + cancel -->
		<div class="flex items-center justify-between">
			<div>
				<h2 class="text-lg font-bold text-text-primary">
					{#if batchRunning}
						Kameras werden eingerichtet...
					{:else}
						Einrichtung abgeschlossen
					{/if}
				</h2>
				<p class="text-sm text-text-secondary">
					{batchDoneCount}/{batchResults.length} fertig{#if batchErrorCount > 0}<span class="text-red-400"> — {batchErrorCount} Fehler</span>{/if}
				</p>
			</div>
			{#if batchRunning}
				<button
					onclick={cancelBatch}
					class="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium cursor-pointer"
				>
					<XCircle class="w-4 h-4" />
					Abbrechen
				</button>
			{:else}
				<button
					onclick={() => goto('/kameras')}
					class="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 text-sm font-medium cursor-pointer flex items-center gap-2"
				>
					Fertig — zu den Kameras
					{#if autoRedirectSeconds > 0}
						<span class="text-xs opacity-70">({autoRedirectSeconds}s)</span>
					{/if}
				</button>
			{/if}
		</div>

		<!-- Progress bar -->
		<div class="h-1.5 bg-bg-input rounded-full overflow-hidden">
			<div
				class="h-full rounded-full transition-all duration-500 {batchErrorCount > 0 ? 'bg-yellow-400' : 'bg-accent'}"
				style="width: {((batchDoneCount + batchErrorCount) / batchResults.length * 100).toFixed(0)}%"
			></div>
		</div>

		<!-- Credential prompt (pauses batch) -->
		{#if credPrompt}
			<div class="bg-yellow-500/10 border border-yellow-500/40 rounded-lg p-4 space-y-3">
				<div class="flex items-center gap-2">
					<KeyRound class="w-5 h-5 text-yellow-400" />
					<h3 class="text-sm font-bold text-yellow-400">
						{credPrompt.kind === 'bambu' ? 'Bambu-Zugang benötigt' : 'Zugangsdaten benötigt'}
					</h3>
				</div>
				<p class="text-sm text-text-secondary">
					{#if credPrompt.kind === 'bambu'}
						Für den Drucker auf <span class="text-text-primary font-mono">{credPrompt.ip}</span> gibt es keinen passenden gespeicherten Login.
						Seriennummer und Access Code (Einstellungen → Netzwerk) am Drucker ablesen. Optional einen Namen vergeben, um den Login künftig wiederzuverwenden.
					{:else}
						Für <span class="text-text-primary font-mono">{credPrompt.ip}</span> wurden keine passenden Zugangsdaten gefunden.
						Gib Benutzername und Passwort ein. Optional einen Namen vergeben, um die Zugangsdaten für zukünftige Kameras zu speichern.
					{/if}
				</p>
				{#if credPromptError}
					<div class="text-red-400 text-xs">{credPromptError}</div>
				{/if}
				{#if credPrompt.kind === 'bambu'}
					<div class="grid grid-cols-3 gap-3">
						<input
							type="text"
							bind:value={credPromptName}
							placeholder="Name (optional)"
							autocomplete="off"
							class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
						/>
						<input
							type="text"
							bind:value={credPromptSerial}
							readonly={credPrompt.kind === 'bambu' && !!credPrompt.prefillSerial}
							placeholder="Seriennummer"
							autocomplete="off"
							title={credPrompt.kind === 'bambu' && credPrompt.prefillSerial ? 'Aus SSDP-Discovery übernommen' : ''}
							class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent font-mono {credPrompt.kind === 'bambu' && credPrompt.prefillSerial ? 'opacity-70 cursor-not-allowed' : ''}"
						/>
						<input
							type="password"
							bind:value={credPromptAccessCode}
							placeholder="Access Code (8 Zeichen)"
							maxlength="8"
							autocomplete="off"
							class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent font-mono tracking-widest"
						/>
					</div>
				{:else}
					<div class="grid grid-cols-3 gap-3">
						<input
							type="text"
							bind:value={credPromptName}
							placeholder="Name (optional, z.B. Mobotix Standard)"
							autocomplete="off"
							class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
						/>
						<input
							type="text"
							bind:value={credPromptUser}
							placeholder="Benutzername"
							autocomplete="off"
							class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
						/>
						<input
							type="password"
							bind:value={credPromptPass}
							placeholder="Passwort"
							autocomplete="off"
							class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
						/>
					</div>
				{/if}
				<div class="flex gap-2">
					<button
						onclick={submitCredPrompt}
						disabled={credPromptSaving}
						class="bg-accent text-white rounded-lg px-4 py-2 hover:bg-accent/90 text-sm font-medium cursor-pointer disabled:opacity-50"
					>
						{#if credPromptSaving}
							<Loader2 class="w-4 h-4 animate-spin inline" />
						{:else}
							Weiter
						{/if}
					</button>
					<button
						onclick={skipCredPrompt}
						class="bg-bg-input text-text-secondary rounded-lg px-4 py-2 hover:bg-bg-card text-sm cursor-pointer"
					>
						Kamera überspringen
					</button>
				</div>
			</div>
		{/if}

		<!-- Camera cards -->
		<div class="space-y-3">
			{#each batchResults as cam, i (cam.ip)}
				<div id="batch-cam-{i}" class="bg-bg-card border rounded-lg overflow-hidden transition-colors
					{cam.status === 'active' ? 'border-accent/50' : cam.status === 'error' ? 'border-red-500/30' : cam.status === 'done' ? 'border-green-500/20' : 'border-border'}">

					<!-- Camera header -->
					<div class="px-4 py-3 flex items-center gap-3">
						<!-- Snapshot thumbnail or status icon -->
						{#if cam.snapshotUrl}
							<div class="w-12 h-9 rounded overflow-hidden bg-black shrink-0 relative">
								<img src={cam.snapshotUrl} alt={cam.name} class="w-full h-full object-cover" />
								{#if cam.status === 'done'}
									<div class="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 rounded-tl flex items-center justify-center">
										<Check class="w-2.5 h-2.5 text-white" />
									</div>
								{:else if cam.status === 'active'}
									<div class="absolute bottom-0 right-0 w-3.5 h-3.5 bg-accent rounded-tl flex items-center justify-center">
										<Loader2 class="w-2.5 h-2.5 text-white animate-spin" />
									</div>
								{:else if cam.status === 'error'}
									<div class="absolute bottom-0 right-0 w-3.5 h-3.5 bg-red-500 rounded-tl flex items-center justify-center">
										<XCircle class="w-2.5 h-2.5 text-white" />
									</div>
								{/if}
							</div>
						{:else if cam.status === 'done'}
							<div class="w-7 h-7 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
								<Check class="w-4 h-4 text-green-400" />
							</div>
						{:else if cam.status === 'active'}
							<div class="w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
								<Loader2 class="w-4 h-4 text-accent animate-spin" />
							</div>
						{:else if cam.status === 'error'}
							<div class="w-7 h-7 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
								<XCircle class="w-4 h-4 text-red-400" />
							</div>
						{:else if cam.status === 'skipped'}
							<div class="w-7 h-7 rounded-full bg-bg-input flex items-center justify-center shrink-0">
								<span class="text-text-secondary text-xs">—</span>
							</div>
						{:else}
							<div class="w-7 h-7 rounded-full border-2 border-border shrink-0"></div>
						{/if}

						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="text-text-primary text-sm font-semibold">{cam.name}</span>
								<span class="text-text-secondary text-xs font-mono">{cam.ip}</span>
								{#if cam.type === 'mobotix-onvif'}
									<span class="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">ONVIF</span>
								{:else if cam.type === 'loxone'}
									<span class="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">Loxone</span>
								{:else if cam.type === 'bambu'}
									<span class="text-xs px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400">Bambu Lab</span>
								{:else}
									<span class="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent">Mobotix</span>
								{/if}
							</div>
							{#if cam.containerIp}
								<div class="mt-1.5 flex items-center gap-2 px-2 py-1 rounded bg-accent/10 border border-accent/20">
									<span class="text-xs text-text-secondary">Container-IP:</span>
									<span class="text-xs font-mono text-text-primary">{cam.containerIp}</span>
									<button
										type="button"
										onclick={() => copyContainerIp(cam.containerIp!)}
										class="p-0.5 rounded hover:bg-accent/20 cursor-pointer"
										title="IP kopieren"
										aria-label="Container-IP kopieren"
									>
										{#if copiedIp === cam.containerIp}
											<Check class="w-3.5 h-3.5 text-green-400" />
										{:else}
											<Copy class="w-3.5 h-3.5 text-text-secondary" />
										{/if}
									</button>
									<span class="text-xs text-accent ml-auto">→ Jetzt in UniFi Protect hinzufügbar</span>
								</div>
							{/if}
							{#if cam.status === 'error' && cam.error}
								<p class="text-xs text-red-400 mt-0.5">{cam.error}</p>
							{/if}
						</div>

						<!-- Step dots — always visible, light up as steps complete -->
						<div class="flex items-center gap-1">
							{#each cam.steps as step}
								<div class="w-2 h-2 rounded-full transition-all duration-500
									{step.status === 'done' ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)]'
									: step.status === 'active' ? 'bg-accent animate-pulse'
									: step.status === 'error' ? 'bg-red-400'
									: 'bg-border'}"></div>
							{/each}
						</div>
					</div>

					<!-- Live step details (always visible for active, stays visible for done/error) -->
					{#if cam.status === 'active' || cam.expanded || cam.status === 'error'}
						<div class="px-4 pb-3 border-t border-border/50">
							<div class="space-y-1.5 pt-2.5">
								{#each cam.steps as step, si}
									<div>
										<!-- Main step -->
										<div class="flex items-center gap-2.5 text-xs">
											{#if step.status === 'done'}
												<Check class="w-3.5 h-3.5 text-green-400 shrink-0" />
											{:else if step.status === 'active'}
												<Loader2 class="w-3.5 h-3.5 text-accent animate-spin shrink-0" />
											{:else if step.status === 'error'}
												<XCircle class="w-3.5 h-3.5 text-red-400 shrink-0" />
											{:else}
												<div class="w-3.5 h-3.5 rounded-full border border-border shrink-0"></div>
											{/if}

											<span class="font-medium {step.status === 'active' ? 'text-accent' : step.status === 'done' ? 'text-text-primary' : step.status === 'error' ? 'text-red-400' : 'text-text-secondary'}">
												{step.label}
											</span>

											{#if step.detail}
												<span class="text-text-secondary ml-auto font-mono">{step.detail}</span>
											{/if}
										</div>

										<!-- Sub-steps (visible when step is active or just completed) -->
										{#if step.status === 'active' || (step.status === 'done' && step.subs.some(s => s.status === 'done'))}
											<div class="ml-6 mt-1 mb-1.5 space-y-0.5 border-l border-border/50 pl-3">
												{#each step.subs as sub}
													<div class="flex items-center gap-2 text-[11px] transition-opacity duration-300
														{sub.status === 'pending' ? 'opacity-30' : 'opacity-100'}">
														{#if sub.status === 'done'}
															<Check class="w-3 h-3 text-green-400 shrink-0" />
														{:else if sub.status === 'active'}
															<Loader2 class="w-3 h-3 text-accent animate-spin shrink-0" />
														{:else}
															<div class="w-3 h-3 shrink-0"></div>
														{/if}
														<span class="{sub.status === 'active' ? 'text-accent' : sub.status === 'done' ? 'text-text-secondary' : 'text-text-secondary/50'}">
															{sub.label}
														</span>
													</div>
												{/each}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if batchCancelled && !batchRunning}
			<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-yellow-400 text-sm">
				Abgebrochen. Bereits eingerichtete Kameras bleiben bestehen.
			</div>
		{/if}
	</div>

{:else if selectedIp}
	<button onclick={() => { selectedIp = null; prefillUser = ''; prefillPass = ''; prefillCredName = ''; }} class="text-accent hover:text-accent/80 text-sm mb-4 cursor-pointer">
		&larr; Zurück zur Auswahl
	</button>
	{#if prefillCredName}
		<div class="bg-green-500/10 border border-green-500/30 rounded-lg p-3 mb-4 text-green-400 text-sm">
			Login "{prefillCredName}" automatisch erkannt und vorausgefüllt.
		</div>
	{/if}
	<OnboardingWizard nextVmid={data.nextVmid} prefillIp={selectedIp} prefillUsername={prefillUser} prefillPassword={prefillPass} prefillName={prefillName} cameraType={selectedCameraType} prefillSerial={selectedSerial} prefillModel={selectedModel} />
{:else}
	<!-- Manual entry -->
	<div class="mb-6 space-y-4">
		<div class="bg-bg-card border border-border rounded-lg p-4">
			<h3 class="text-sm font-bold text-text-primary mb-3">Kamera manuell hinzufügen</h3>
			<div class="flex flex-wrap gap-3 mb-4">
				<label class="flex items-center gap-2 cursor-pointer">
					<input type="radio" name="manual-device-type" value="mobotix" bind:group={manualDeviceType} class="accent-accent" />
					<span class="text-sm text-text-primary">Mobotix / Loxone</span>
				</label>
				<label class="flex items-center gap-2 cursor-pointer">
					<input type="radio" name="manual-device-type" value="bambu" bind:group={manualDeviceType} class="accent-accent" />
					<span class="text-sm text-text-primary flex items-center gap-1.5"><Printer class="w-3.5 h-3.5 text-orange-400" /> Bambu Lab</span>
				</label>
			</div>

			{#if manualDeviceType === 'bambu'}
				<div class="space-y-3">
					<div>
						<label for="manual-bambu-ip" class="block text-xs text-text-secondary mb-1">Drucker-IP</label>
						<input
							id="manual-bambu-ip"
							type="text"
							bind:value={manualBambuIp}
							placeholder="192.0.2.109"
							autocomplete="off"
							class="w-full md:w-72 bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent font-mono"
						/>
					</div>
					<button
						type="button"
						onclick={startManualBambu}
						disabled={!manualBambuIp.trim()}
						class="bg-orange-500 text-white rounded-lg px-4 py-2 hover:bg-orange-600 transition-colors text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Weiter — Seriennummer + Access Code eingeben
					</button>
				</div>
			{:else}
				<OnboardingWizard nextVmid={data.nextVmid} />
			{/if}
		</div>
	</div>

	<!-- Auto-Discovery -->
	<div class="border-t border-border pt-6">
		<div class="flex items-center gap-2 mb-4">
			<Wifi class="w-5 h-5 text-accent" />
			<h2 class="text-lg font-bold text-text-primary">Gefundene Kameras im Netzwerk</h2>
			{#if scanning}
				<Loader2 class="w-4 h-4 animate-spin text-text-secondary" />
				<span class="text-xs text-text-secondary">Scanne...</span>
			{:else}
				<span class="text-xs text-text-secondary">({discovered.length} neue gefunden)</span>
				<button onclick={runDiscovery} class="text-xs text-accent hover:text-accent/80 cursor-pointer ml-2">Erneut scannen</button>
			{/if}
		</div>

		{#if !scanning && discovered.length > 0}
			<!-- Add All Button -->
			<div class="mb-4">
				<button
					onclick={startBatch}
					class="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 text-sm font-medium cursor-pointer"
				>
					<PlayCircle class="w-4 h-4" />
					Alle hinzufügen ({discovered.length})
				</button>
			</div>
		{/if}

		{#if !scanning && discovered.length === 0}
			<p class="text-text-secondary text-sm">Keine neuen Kameras im Netzwerk gefunden.</p>
		{:else}
			<div class="space-y-3">
				{#each discovered as cam (cam.ip)}
					<div class="bg-bg-card border border-border rounded-lg p-4">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								{#if discoveryThumbnails.get(cam.ip)}
									<div class="w-14 h-10 rounded overflow-hidden bg-black shrink-0">
										<img src={discoveryThumbnails.get(cam.ip)} alt={cam.name || cam.ip} class="w-full h-full object-cover" />
									</div>
								{:else}
									<span class="w-2 h-2 rounded-full bg-green-400 shrink-0"></span>
								{/if}
								{#if cam.name}
									<span class="text-text-primary font-medium">{cam.name}</span>
								{/if}
								<span class="text-text-primary font-mono {cam.name ? 'text-text-secondary text-xs' : 'font-medium'}">{cam.ip}</span>
								{#if cam.type === 'mobotix-onvif'}
									<span class="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">MOBOTIX ONVIF</span>
									<span class="text-xs text-text-secondary">Nativ — kein Container nötig</span>
								{:else if cam.type === 'mobotix'}
									<span class="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">MOBOTIX</span>
									<span class="text-xs text-text-secondary">Braucht Pipeline (go2rtc + ONVIF)</span>
								{:else if cam.type === 'bambu'}
									<Printer class="w-4 h-4 text-orange-400" />
									<span class="text-xs px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400">BAMBU LAB {cam.model ?? ''}</span>
									{#if cam.lanModeHint === 'likely_on'}
										<span class="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">LAN Mode</span>
									{/if}
								{:else}
									<span class="text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 uppercase">{cam.type}</span>
								{/if}
							</div>
							{#if cam.type === 'mobotix-onvif'}
								<button
									onclick={() => startRegister(cam.ip, cam.name)}
									class="bg-green-600 text-white rounded-lg px-4 py-2 hover:bg-green-700 transition-colors text-sm cursor-pointer"
								>
									Registrieren
								</button>
							{:else if cam.type === 'bambu'}
								<button
									onclick={() => selectCamera(cam.ip, cam.name ?? 'Bambu Lab H2C', 'bambu', cam.serialNumber, cam.model)}
									class="bg-orange-500 text-white rounded-lg px-4 py-2 hover:bg-orange-600 transition-colors text-sm cursor-pointer"
								>
									Einrichten
								</button>
							{:else}
								<button
									onclick={() => selectCamera(cam.ip, cam.name, cam.type)}
									class="bg-accent text-white rounded-lg px-4 py-2 hover:bg-accent/90 transition-colors text-sm cursor-pointer"
								>
									Einrichten
								</button>
							{/if}
						</div>

						<!-- Inline register form for native ONVIF -->
						{#if registeringIp === cam.ip}
							<div class="mt-3 pt-3 border-t border-border space-y-3">
								{#if registerError}
									<div class="text-red-400 text-xs">{registerError}</div>
								{/if}
								<div class="grid grid-cols-3 gap-3">
									<input
										type="text"
										bind:value={registerName}
										placeholder="Kamera-Name"
										autocomplete="off"
										class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
									/>
									<input
										type="text"
										bind:value={registerUser}
										placeholder="Benutzername"
										autocomplete="off"
										class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
									/>
									<input
										type="password"
										bind:value={registerPass}
										placeholder="Passwort"
										autocomplete="off"
										class="bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
									/>
								</div>
								<div class="flex gap-2">
									<button
										onclick={submitRegister}
										disabled={registerLoading}
										class="bg-green-600 text-white rounded-lg px-4 py-2 hover:bg-green-700 transition-colors text-sm cursor-pointer disabled:opacity-50"
									>
										{#if registerLoading}
											<Loader2 class="w-4 h-4 animate-spin inline" />
										{:else}
											Speichern
										{/if}
									</button>
									<button
										onclick={resetRegisterForm}
										class="bg-bg-input text-text-secondary rounded-lg px-4 py-2 hover:bg-bg-card text-sm cursor-pointer"
									>
										Abbrechen
									</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
