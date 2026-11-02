<script lang="ts">
	import type { CameraCardData } from '$lib/types';
	import { ExternalLink, Copy, Check, Play, Square, RotateCw, Trash2, Pencil, KeyRound, Loader2, Power, Lock, LockOpen, Eye, EyeOff, Activity } from 'lucide-svelte';
	import AdoptionGuide from './AdoptionGuide.svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { deriveSlug } from '$lib/protect-hub/slug';

	let {
		camera,
		hubAugment = null,
		bridgeIp = null
	}: {
		camera: CameraCardData;
		hubAugment?: CameraCardData | null;
		bridgeIp?: string | null;
	} = $props();

	// P22-UAT 2026-05-15: when this managed cam is also represented in Protect
	// Hub (matching protectId), the parent /kameras passes the external row
	// here as `hubAugment`. We compute the Hub-bridge RTSP/MJPEG URLs and
	// render them in an additional info block. Keyed by output type → slug.
	const hubBridgeUrls = $derived.by(() => {
		if (!hubAugment || !bridgeIp || !hubAugment.mac) return null;
		const out: Array<{ outputType: 'loxone-mjpeg' | 'frigate-rtsp'; url: string; label: string }> = [];
		for (const o of hubAugment.outputs ?? []) {
			if (!o.enabled) continue;
			const slug = deriveSlug(hubAugment.mac, o.outputType);
			if (o.outputType === 'loxone-mjpeg') {
				out.push({
					outputType: 'loxone-mjpeg',
					url: `http://${bridgeIp}:1984/api/stream.mjpeg?src=${slug}`,
					label: 'Loxone MJPEG (640x360@10fps)'
				});
			} else {
				out.push({
					outputType: 'frigate-rtsp',
					url: `rtsp://${bridgeIp}:8554/${slug}`,
					label: 'RTSP-Passthrough (Frigate / NVR)'
				});
			}
		}
		return out.length > 0 ? out : null;
	});

	let hubCopied = $state<string | null>(null);
	async function copyHubUrl(url: string) {
		if (await copyToClipboard(url)) {
			hubCopied = url;
			setTimeout(() => (hubCopied = null), 2000);
		}
	}

	// P22-UAT 2026-05-15: when the cam has no LXC (mobotix-onvif → native
	// Protect ONVIF adoption, no container), the old placeholder showed
	// "Container gestoppt" — misleading because no container is *expected*.
	// If a Hub-bridge MJPEG output exists for the cam, use it as the live
	// view source; otherwise show a clear "native Protect" caption.
	const hubMjpegSlug = $derived.by(() => {
		if (!hubAugment || !hubAugment.mac) return null;
		const has = (hubAugment.outputs ?? []).some(
			(o) => o.enabled && o.outputType === 'loxone-mjpeg'
		);
		return has ? deriveSlug(hubAugment.mac, 'loxone-mjpeg') : null;
	});
	const hubLiveStreamUrl = $derived(
		bridgeIp && hubMjpegSlug
			? `http://${bridgeIp}:1984/api/stream.mjpeg?src=${hubMjpegSlug}`
			: null
	);

	// P22-UAT 2026-05-15 — In-card live view URL (for <img src>):
	//   * mobotix-onvif (no LXC) + Hub augment → bridge MJPEG (works)
	//   * managed LXC with running container → null here (use the existing
	//     snapshotSrc poll path, which calls /api/cameras/{id}/snapshot
	//     under the hood = go2rtc frame.jpeg. The LXC's stream.mjpeg path
	//     would require an H.264→MJPEG transcode that hits the same
	//     go2rtc 1.9.14 VAAPI filter-chain bug as the loxone-mjpeg
	//     pipeline — proven 0-byte response during this UAT).
	const liveViewUrl = $derived(hubLiveStreamUrl);

	// User-copyable MJPEG link. User feedback: "Mobotix S15 gibt direkt
	// MJPEG aus — nur den link". Three sources:
	//   1. Hub bridge MJPEG (when augmented)            → known-working
	//   2. Mobotix native cam MJPEG (cam-direct)         → works in VLC/ffmpeg;
	//      embedded creds work in <img> only on older browsers, but the link
	//      is still copyable for any consumer.
	//   3. otherwise null (don't render a misleading bar)
	const cameraMjpegUrl = $derived.by(() => {
		if (hubAugment && hubAugment.mac && bridgeIp) {
			const has = (hubAugment.outputs ?? []).some(
				(o) => o.enabled && o.outputType === 'loxone-mjpeg'
			);
			if (has) {
				return `http://${bridgeIp}:1984/api/stream.mjpeg?src=${deriveSlug(hubAugment.mac, 'loxone-mjpeg')}`;
			}
		}
		if (
			(camera.cameraType === 'mobotix' || camera.cameraType === 'mobotix-onvif') &&
			camera.cameraWebUrl
		) {
			return `${camera.cameraWebUrl.replace(/\/$/, '')}/control/faststream.jpg?stream=full&fps=20`;
		}
		return null;
	});

	let mjpegUrlCopied = $state(false);
	async function copyMjpegUrl() {
		if (!cameraMjpegUrl) return;
		if (await copyToClipboard(cameraMjpegUrl)) {
			mjpegUrlCopied = true;
			setTimeout(() => (mjpegUrlCopied = false), 2000);
		}
	}
	let copied = $state(false);
	let editing = $state(false);
	let editName = $state(camera.name);
	let renameLoading = $state(false);

	async function saveName() {
		if (!editName.trim() || editName === camera.name) { editing = false; return; }
		renameLoading = true;
		try {
			const res = await fetch(`/api/cameras/${camera.id}/rename`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: editName.trim() })
			});
			if ((await res.json()).success) {
				camera.name = editName.trim();
			}
		} catch { /* ignore */ }
		finally { renameLoading = false; editing = false; }
	}

	// Camera probe data (loaded separately, every 5s)
	let probeData = $state<{
		liveFps: number | null;
		maxFps: number | null;
		cameraModel: string | null;
		firmwareVersion: string | null;
		codec: string | null;
	} | null>(null);

	// When RTSP-Auth is active, the raw rtspUrl stored in the DB is not
	// directly usable (it lacks credentials) — users need the URL with
	// user:password embedded for manual tooling. Derive the authoritative
	// "use this" URL once so the UI has a single source of truth.
	function buildRtspUrlWithCreds(base: string, user: string, pw: string): string {
		return base.replace(/^rtsp:\/\//, `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@`);
	}
	let rtspDisplayUrl = $derived.by(() => {
		if (!camera.rtspUrl) return '';
		if (!camera.rtspAuthEnabled) return camera.rtspUrl;
		if (!authCreds) return camera.rtspUrl; // still loading — fall back to plain
		return buildRtspUrlWithCreds(camera.rtspUrl, authCreds.username, authCreds.password);
	});
	let rtspMaskedUrl = $derived.by(() => {
		if (!camera.rtspUrl || !camera.rtspAuthEnabled || !authCreds) return rtspDisplayUrl;
		// Cosmetic mask — bypass buildRtspUrlWithCreds because
		// encodeURIComponent('•') = '%E2%80%A2', so reusing the helper would
		// render rtsp://user:%E2%80%A2%E2%80%A2%E2%80%A2@... instead of
		// rtsp://user:••••••@... . URL validity is irrelevant for a masked
		// preview that's never used as an actual stream URL.
		return camera.rtspUrl.replace(
			/^rtsp:\/\//,
			`rtsp://${encodeURIComponent(authCreds.username)}:••••••@`
		);
	});

	async function copyRtsp() {
		if (!rtspDisplayUrl) return;
		if (await copyToClipboard(rtspDisplayUrl)) {
			copied = true;
			setTimeout(() => { copied = false; }, 2000);
		}
	}

	let onvifCopied = $state(false);
	async function copyOnvif() {
		if (!camera.containerIp) return;
		if (await copyToClipboard(`${camera.containerIp}:8899`)) {
			onvifCopied = true;
			setTimeout(() => { onvifCopied = false; }, 2000);
		}
	}

	// RTSP-Auth state — username loads on mount (visible by default),
	// password stays in memory but is only rendered behind the eye-toggle.
	let authCreds = $state<{ username: string; password: string } | null>(null);
	let authLoading = $state(false);
	let authError = $state<string | null>(null);
	let authPwVisible = $state(false);
	let authUserCopied = $state(false);
	let authPwCopied = $state(false);
	let authUrlCopied = $state(false);
	let authToggleHint = $state<string | null>(null);

	// Auto-fetch once when the card shows an auth-enabled camera — so the
	// username is visible immediately instead of being gated behind a click.
	$effect(() => {
		if (camera.rtspAuthEnabled && !authCreds && !authLoading) {
			void ensureAuthCreds();
		}
	});

	async function ensureAuthCreds(): Promise<void> {
		if (authCreds) return;
		authLoading = true;
		authError = null;
		try {
			const res = await fetch(`/api/cameras/${camera.id}/credentials`);
			if (!res.ok) { authError = 'Konnte Zugangsdaten nicht laden'; return; }
			const data = await res.json();
			authCreds = { username: data.username, password: data.password };
		} catch {
			authError = 'Netzwerkfehler';
		} finally {
			authLoading = false;
		}
	}

	async function toggleAuthReveal() {
		if (!authCreds) await ensureAuthCreds();
		authPwVisible = !authPwVisible;
	}

	async function copyAuthUser() {
		await ensureAuthCreds();
		if (!authCreds) return;
		if (await copyToClipboard(authCreds.username)) {
			authUserCopied = true;
			setTimeout(() => { authUserCopied = false; }, 2000);
		}
	}
	async function copyAuthPw() {
		await ensureAuthCreds();
		if (!authCreds) return;
		if (await copyToClipboard(authCreds.password)) {
			authPwCopied = true;
			setTimeout(() => { authPwCopied = false; }, 2000);
		}
	}
	async function copyAuthRtspUrl() {
		await ensureAuthCreds();
		if (!authCreds || !camera.rtspUrl) return;
		const u = encodeURIComponent(authCreds.username);
		const p = encodeURIComponent(authCreds.password);
		const withCreds = camera.rtspUrl.replace(/^rtsp:\/\//, `rtsp://${u}:${p}@`);
		if (await copyToClipboard(withCreds)) {
			authUrlCopied = true;
			setTimeout(() => { authUrlCopied = false; }, 2000);
		}
	}

	async function setRtspAuth(enabled: boolean) {
		authLoading = true;
		authError = null;
		authToggleHint = null;
		try {
			const res = await fetch(`/api/cameras/${camera.id}/rtsp-auth`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			const data = await res.json();
			if (data.success) {
				camera.rtspAuthEnabled = enabled;
				authToggleHint = data.message ?? null;
				if (enabled) await ensureAuthCreds();
			} else {
				authError = data.error || 'Umschalten fehlgeschlagen';
			}
		} catch {
			authError = 'Netzwerkfehler';
		} finally {
			authLoading = false;
		}
	}

	let actionLoading = $state(false);
	let showDeleteConfirm = $state(false);

	// Credentials modal
	let showCredentials = $state(false);
	let credUsername = $state('');
	let credPassword = $state('');
	let credLoading = $state(false);
	let credError = $state('');
	let credSuccess = $state(false);

	function openCredentials() {
		credUsername = '';
		credPassword = '';
		credError = '';
		credSuccess = false;
		showCredentials = true;
	}

	async function saveCredentials() {
		credLoading = true;
		credError = '';
		credSuccess = false;
		try {
			const res = await fetch(`/api/cameras/${camera.id}/credentials`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: credUsername, password: credPassword, test: true })
			});
			const data = await res.json();
			if (data.success) {
				credSuccess = true;
				setTimeout(() => { showCredentials = false; }, 1500);
			} else {
				credError = data.error || 'Fehler beim Speichern';
			}
		} catch {
			credError = 'Verbindung fehlgeschlagen';
		} finally {
			credLoading = false;
		}
	}

	// Camera reboot (Mobotix)
	let rebootLoading = $state(false);
	let rebootConfirm = $state(false);
	let rebooting = $state(false);

	// Bambu stream mode (Phase 14)
	let streamModeUpdating = $state(false);
	async function updateStreamMode(mode: string) {
		streamModeUpdating = true;
		try {
			await fetch(`/api/cameras/${camera.id}/bambu-state`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ streamMode: mode })
			});
			// Optimistic update — next /api/cameras/status poll will overwrite with DB truth
			camera.streamMode = mode;
		} catch {
			// Silent — next poll will reflect actual state
		} finally {
			streamModeUpdating = false;
		}
	}

	async function rebootCamera() {
		rebootLoading = true;
		rebootConfirm = false;
		try {
			const res = await fetch(`/api/cameras/${camera.id}/reboot`, { method: 'POST' });
			const data = await res.json();
			if (data.success) {
				rebooting = true;
				snapshotSrc = '';
				// Mobotix reboot takes ~60-90s, clear state after 90s
				setTimeout(() => { rebooting = false; }, 90000);
			}
		} catch { /* ignore */ }
		finally {
			rebootLoading = false;
		}
	}

	async function containerAction(action: 'start' | 'stop' | 'restart') {
		actionLoading = true;
		try {
			const res = await fetch(`/api/proxmox/containers/${camera.vmid}/${action}`, { method: 'POST' });
			if (!res.ok) {
				// Silently handle — status will update on next poll
			}
		} catch { /* network error during restart is expected */ }
		finally {
			// Wait a moment for Proxmox to process, then release
			setTimeout(() => { actionLoading = false; }, 3000);
		}
	}

	async function deleteCamera() {
		actionLoading = true;
		try {
			await fetch(`/api/cameras/${camera.id}/delete`, { method: 'POST' });
		} catch { /* ignore */ }
		showDeleteConfirm = false;
		window.location.reload();
	}

	let showAdoptionGuide = $state(false);
	let isNativeOnvif = $derived(camera.cameraType === 'mobotix-onvif');
	let isRunning = $derived(isNativeOnvif || camera.containerStatus === 'running');
	let snapshotSrc = $state('');

	function refreshSnapshot() {
		if (!isRunning || rebooting) return;
		if (!camera.snapshotUrl && !isNativeOnvif) return;
		const img = new Image();
		img.onload = () => { if (!rebooting) snapshotSrc = img.src; };
		img.onerror = () => {
			// Snapshot failed — camera might be rebooting or offline
			if (rebooting) snapshotSrc = '';
		};
		img.src = `${camera.snapshotUrl}?t=${Date.now()}`;
	}

	$effect(() => {
		if (!isRunning || rebooting) return;
		refreshSnapshot();
		const timer = setInterval(refreshSnapshot, 10000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (!isRunning || rebooting) return;
		fetchProbe();
		const timer = setInterval(fetchProbe, 30000);
		return () => clearInterval(timer);
	});

	async function fetchProbe() {
		try {
			const res = await fetch(`/api/cameras/${camera.id}/probe`);
			if (res.ok) probeData = await res.json();
		} catch { /* ignore */ }
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
	}
</script>

<div class="bg-bg-card border border-border rounded-lg overflow-hidden w-full">
	<!-- Top: Stream + LXC info side by side -->
	<div class="flex flex-col lg:flex-row">
		<!-- Live Stream. P22-UAT 2026-05-15 amendment:
		     1. Default: live MJPEG via <img src=stream.mjpeg> (browser-native MJPEG
		        animation). Replaces the 10 s snapshot poll that produced a still image.
		     2. mobotix-onvif (no LXC): Hub-bridge MJPEG used when available.
		     3. Pure native-onvif without Hub: clear caption.
		-->
		<div
			class="flex-1 relative bg-black {!liveViewUrl && !isRunning && !isNativeOnvif
				? 'opacity-40'
				: ''}"
			style="aspect-ratio: {camera.width || 16}/{camera.height || 9};"
		>
			{#if rebooting}
				<div class="absolute inset-0 flex flex-col items-center justify-center text-warning text-sm gap-2">
					<Loader2 class="w-6 h-6 animate-spin" />
					<span>Kamera startet neu...</span>
				</div>
			{:else if liveViewUrl && (isRunning || hubLiveStreamUrl)}
				<!-- Browser streams <img src=stream.mjpeg> as a continuous MJPEG
				     animation natively — no JS playback layer needed. The cache-
				     buster ensures each card mount starts a fresh connection. -->
				<img
					src={liveViewUrl}
					alt={camera.name}
					class="w-full h-full object-contain"
				/>
			{:else if snapshotSrc && isRunning}
				<!-- Fallback for managed cams without hub-bridge MJPEG: the 10s
				     snapshotSrc poll fetches JPEG via /api/cameras/{id}/snapshot
				     (go2rtc frame.jpeg with Mobotix-direct cam-fetch fallback). -->
				<img
					src={snapshotSrc}
					alt={camera.name}
					class="w-full h-full object-contain"
				/>
			{:else}
				<div class="absolute inset-0 flex items-center justify-center text-text-secondary/50 text-sm">
					{#if isNativeOnvif && !hubLiveStreamUrl}
						Native UniFi Protect · kein lokales MJPEG verfügbar
					{:else if isRunning}
						Bild wird geladen...
					{:else}
						Container gestoppt
					{/if}
				</div>
			{/if}
			<div class="absolute top-3 left-3 flex items-center gap-2">
				{#if editing}
					<div class="flex items-center gap-1 bg-black/70 backdrop-blur-sm rounded-md px-2 py-1">
						<input
							type="text"
							bind:value={editName}
							class="bg-transparent text-text-primary text-sm font-bold outline-none w-32"
							onkeydown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') editing = false; }}
						/>
						<button onclick={saveName} class="text-green-400 hover:text-green-300 cursor-pointer"><Check class="w-4 h-4" /></button>
					</div>
				{:else}
					<span class="bg-black/70 backdrop-blur-sm text-text-primary text-sm font-bold px-3 py-1 rounded-md">{camera.name}</span>
					<button onclick={() => { editName = camera.name; editing = true; }} class="bg-black/70 backdrop-blur-sm text-text-secondary hover:text-text-primary rounded-md p-1 cursor-pointer" title="Umbenennen">
						<Pencil class="w-3.5 h-3.5" />
					</button>
					<a href={`/kameras/${camera.id}/debug`} class="bg-black/70 backdrop-blur-sm text-text-secondary hover:text-text-primary rounded-md p-1" title="Debug-Panel öffnen">
						<Activity class="w-3.5 h-3.5" />
					</a>
					{#if camera.cameraType !== 'bambu'}
						<button onclick={openCredentials} class="bg-black/70 backdrop-blur-sm text-text-secondary hover:text-text-primary rounded-md p-1 cursor-pointer" title="Zugangsdaten ändern">
							<KeyRound class="w-3.5 h-3.5" />
						</button>
						<a href={camera.cameraWebUrl || `http://${camera.cameraIp}`} target="_blank" class="bg-black/70 backdrop-blur-sm text-text-secondary hover:text-text-primary rounded-md p-1" title="Kamera-Webinterface öffnen">
							<ExternalLink class="w-3.5 h-3.5" />
						</a>
					{/if}
					{#if camera.cameraType === 'mobotix' || camera.cameraType === 'mobotix-onvif' || camera.cameraType === 'loxone'}
						{#if rebootConfirm}
							<button onclick={rebootCamera} disabled={rebootLoading} class="bg-red-500/80 backdrop-blur-sm text-white rounded-md px-2 py-0.5 text-xs cursor-pointer">
								Neustart?
							</button>
							<button onclick={() => rebootConfirm = false} class="bg-black/70 backdrop-blur-sm text-text-secondary hover:text-text-primary rounded-md px-2 py-0.5 text-xs cursor-pointer">
								Abbrechen
							</button>
						{:else}
							<button onclick={() => rebootConfirm = true} class="bg-black/70 backdrop-blur-sm text-text-secondary hover:text-text-primary rounded-md p-1 cursor-pointer" title="Kamera neustarten">
								<Power class="w-3.5 h-3.5" />
							</button>
						{/if}
					{/if}
				{/if}
			</div>
		</div>

		<!-- LXC Container Info (only for managed pipeline cameras).
			 v1.3 Phase 22 Plan 03 Task 1: defensive gate on `camera.source !== 'external'`.
			 The /kameras partition routes external Protect cams to <ExternalCamCard> instead
			 of CameraDetailCard, so this branch is unreachable via the normal page render.
			 The extra check is defense-in-depth: it eliminates the live-VM "LXC 0 + red dot"
			 bug that surfaced on 22 external rows on prior builds (CONTEXT.md §specifics).
		-->
		{#if !isNativeOnvif && camera.source !== 'external'}
		<div class="lg:w-64 xl:w-72 shrink-0 p-4 bg-bg-primary/30 border-l border-border">
			<div class="flex items-center gap-2 mb-3">
				<span class="w-2.5 h-2.5 rounded-full {camera.containerStatus === 'running' ? 'bg-green-400' : 'bg-red-400'}"></span>
				<span class="text-sm font-bold text-text-primary">LXC {camera.vmid}</span>
				<span class="text-xs text-text-secondary ml-auto">{camera.containerStatus}</span>
			</div>
			<div class="space-y-2 text-xs">
				<div>
					<div class="flex justify-between text-text-secondary mb-0.5">
						<span>CPU</span>
						<span class="text-text-primary">{camera.lxcCpu != null ? `${(camera.lxcCpu * 100).toFixed(1)}%` : '—'}</span>
					</div>
					{#if camera.lxcCpu != null}
						<div class="w-full h-1.5 bg-bg-input rounded-full overflow-hidden">
							<div class="h-full rounded-full {camera.lxcCpu > 0.8 ? 'bg-red-400' : camera.lxcCpu > 0.5 ? 'bg-yellow-400' : 'bg-green-400'}"
								style="width: {Math.min(camera.lxcCpu * 100, 100)}%"></div>
						</div>
					{/if}
				</div>
				<div>
					<div class="flex justify-between text-text-secondary mb-0.5">
						<span>RAM</span>
						<span class="text-text-primary">
							{#if camera.lxcMemory}
								{formatBytes(camera.lxcMemory.used)} / {formatBytes(camera.lxcMemory.total)}
							{:else}
								—
							{/if}
						</span>
					</div>
					{#if camera.lxcMemory}
						{@const memPercent = camera.lxcMemory.used / camera.lxcMemory.total}
						<div class="w-full h-1.5 bg-bg-input rounded-full overflow-hidden">
							<div class="h-full rounded-full {memPercent > 0.8 ? 'bg-red-400' : memPercent > 0.5 ? 'bg-yellow-400' : 'bg-green-400'}"
								style="width: {Math.min(memPercent * 100, 100)}%"></div>
						</div>
					{/if}
				</div>
				<div class="flex justify-between text-text-secondary">
					<span>IP</span>
					<span class="font-mono text-text-primary">{camera.containerIp || '—'}</span>
				</div>
				<div class="flex justify-between text-text-secondary">
					<span>Hostname</span>
					<span class="text-text-primary">cam-{camera.vmid}</span>
				</div>
				{#if camera.lxcMac}
					<div class="flex justify-between text-text-secondary">
						<span>MAC</span>
						<span class="font-mono text-text-primary text-[10px]">{camera.lxcMac}</span>
					</div>
				{/if}
			</div>

			<!-- Bambu-specific: print state + stream mode (Phase 14) -->
			{#if camera.cameraType === 'bambu'}
				<div class="mt-3 pt-3 border-t border-border space-y-2">
					{#if camera.bambuError}
						{@const isAuth = camera.bambuError === 'WRONG_ACCESS_CODE'}
						<div class="rounded border {isAuth ? 'border-red-500/40 bg-red-500/10' : 'border-yellow-500/40 bg-yellow-500/10'} p-2 text-xs space-y-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="{isAuth ? 'text-red-400' : 'text-yellow-400'} font-medium">
									{#if camera.bambuError === 'WRONG_ACCESS_CODE'}
										Access Code ungültig
									{:else if camera.bambuError === 'LAN_MODE_OFF'}
										LAN Mode am Drucker aus
									{:else if camera.bambuError === 'PRINTER_UNREACHABLE'}
										Drucker nicht erreichbar
									{:else if camera.bambuError === 'MQTT_DISCONNECTED'}
										MQTT getrennt
									{:else}
										{camera.bambuError}
									{/if}
								</span>
							</div>
							<p class="text-text-secondary text-[10px] leading-tight">
								{#if camera.bambuError === 'WRONG_ACCESS_CODE'}
									Der Access Code rotiert, wenn LAN Mode auf dem Drucker neu aktiviert wird. Prüfe ihn am Drucker-Display.
								{:else if camera.bambuError === 'LAN_MODE_OFF'}
									Settings → WLAN → LAN Mode am Drucker-Display einschalten.
								{:else if camera.bambuError === 'PRINTER_UNREACHABLE'}
									Drucker nicht im Netzwerk (abgeschaltet oder anderer Subnet).
								{:else}
									MQTT-Verbindung wird alle 15s neu versucht.
								{/if}
							</p>
						</div>
					{/if}
					<div class="flex items-center justify-between text-xs">
						<span class="text-text-secondary">Druckstatus</span>
						{#if !camera.printState}
							<span class="text-text-secondary">—</span>
						{:else if camera.printState === 'RUNNING'}
							<span class="px-2 py-0.5 rounded bg-green-500/20 text-green-400 font-medium">Live (RUNNING)</span>
						{:else if camera.printState === 'PREPARE'}
							<span class="px-2 py-0.5 rounded bg-green-500/20 text-green-400 font-medium">Live (PREPARE)</span>
						{:else if camera.printState === 'PAUSE'}
							<span class="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-medium">Live (PAUSE)</span>
						{:else if camera.printState === 'FINISH'}
							<span class="px-2 py-0.5 rounded bg-text-secondary/20 text-text-secondary font-medium">Idle (FINISH)</span>
						{:else if camera.printState === 'IDLE'}
							<span class="px-2 py-0.5 rounded bg-text-secondary/20 text-text-secondary font-medium">Idle</span>
						{:else if camera.printState === 'FAILED'}
							<!-- Bambu sendet gcode_state=FAILED auch bei Benutzer-Abbruch
							     (nicht nur bei echten Druckerfehlern). Ohne print_error-
							     Feld können wir die beiden Fälle nicht sauber trennen,
							     darum neutrales orange-gelb statt rot-Alarm. -->
							<span class="px-2 py-0.5 rounded bg-orange-500/20 text-orange-400 font-medium" title="Abbruch oder Fehler — Bambu unterscheidet beide über gcode_state=FAILED nicht">Abbruch/Fehler</span>
						{:else}
							<span class="text-text-primary font-mono">{camera.printState}</span>
						{/if}
					</div>
					<div class="flex items-center justify-between text-xs gap-2">
						<span class="text-text-secondary shrink-0">Stream-Modus</span>
						<select
							value={camera.streamMode ?? 'adaptive'}
							onchange={(e) => updateStreamMode((e.currentTarget as HTMLSelectElement).value)}
							disabled={streamModeUpdating}
							class="bg-bg-input border border-border rounded px-1.5 py-0.5 text-text-primary text-xs focus:border-accent focus:outline-none disabled:opacity-50 cursor-pointer"
						>
							<option value="adaptive">Adaptive (MQTT)</option>
							<option value="always_live">Immer Live</option>
							<option value="always_snapshot">Immer Aus</option>
						</select>
					</div>

					<!-- Phase 18 / BAMBU-A1-11: capability-gated model-specific panels.
					     Chamber heater panel hidden on A1 + P1S (chamberHeater=false).
					     A1 reports chamber_temper=5 as a sentinel — don't display
					     that value (CONTEXT.md Sharp Edge #4). -->
					{#if camera.capabilities?.chamberHeater}
						<div class="flex items-center justify-between text-xs">
							<span class="text-text-secondary">Kammertemperatur</span>
							<span class="text-text-secondary">—</span>
						</div>
					{/if}

					<!-- AMS panel: hidden when ams='none', labelled 'AMS Lite' on A1,
					     'AMS' for full. -->
					{#if camera.capabilities && camera.capabilities.ams !== 'none'}
						<div class="flex items-center justify-between text-xs">
							<span class="text-text-secondary shrink-0">
								{camera.capabilities.ams === 'lite' ? 'AMS Lite' : 'AMS'}
							</span>
							<span class="text-text-secondary">—</span>
						</div>
					{/if}

					<!-- Xcam feature toggles: only render toggles for features the
					     model actually supports. A1 exposes only buildplateMarkerDetector. -->
					{#if camera.capabilities?.xcamFeatures?.includes('buildplateMarkerDetector')}
						<div class="flex items-center justify-between text-xs">
							<span class="text-text-secondary shrink-0">Bauplatten-Marker</span>
							<span class="text-text-secondary">xcam</span>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Container Actions -->
			<div class="flex items-center gap-1.5 mt-3 pt-3 border-t border-border">
				<button onclick={() => containerAction('start')} disabled={actionLoading || camera.containerStatus === 'running'}
					class="flex items-center gap-1 px-2 py-1 text-xs rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" title="Start">
					<Play class="w-3 h-3" /> Start
				</button>
				<button onclick={() => containerAction('stop')} disabled={actionLoading || camera.containerStatus === 'stopped'}
					class="flex items-center gap-1 px-2 py-1 text-xs rounded bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" title="Stop">
					<Square class="w-3 h-3" /> Stop
				</button>
				<button onclick={() => containerAction('restart')} disabled={actionLoading}
					class="flex items-center gap-1 px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" title="Restart">
					<RotateCw class="w-3 h-3" /> Restart
				</button>
				<button onclick={() => showDeleteConfirm = true} disabled={actionLoading}
					class="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer ml-auto" title="Löschen">
					<Trash2 class="w-3 h-3" />
				</button>
			</div>

			<!-- Delete Confirm -->
			{#if showDeleteConfirm}
				<div class="mt-2 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
					<p class="text-xs text-red-400 mb-2">"{camera.name}" (LXC {camera.vmid}) wirklich löschen?</p>
					<div class="flex gap-2">
						<button onclick={deleteCamera} class="px-3 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600 cursor-pointer">Löschen</button>
						<button onclick={() => showDeleteConfirm = false} class="px-3 py-1 text-xs bg-bg-input text-text-secondary rounded hover:bg-bg-card cursor-pointer">Abbrechen</button>
					</div>
				</div>
			{/if}
		</div>
		{:else}
		<!-- Native ONVIF info panel -->
		<div class="lg:w-64 xl:w-72 shrink-0 p-4 bg-bg-primary/30 border-l border-border">
			<div class="flex items-center gap-2 mb-3">
				<span class="w-2.5 h-2.5 rounded-full {rebooting ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}"></span>
				<span class="text-sm font-bold text-text-primary">{rebooting ? 'Neustart...' : 'Nativ ONVIF'}</span>
				{#if camera.cameraWebUrl}
					<a href={camera.cameraWebUrl} target="_blank" class="text-accent hover:text-accent/80 ml-auto" title="Kamera-Webinterface öffnen">
						<ExternalLink class="w-3.5 h-3.5" />
					</a>
				{/if}
			</div>
			<div class="space-y-0.5 text-xs text-text-secondary">
				<div class="flex justify-between"><span>IP</span><span class="font-mono text-text-primary">{camera.cameraIp}</span></div>
				{#if probeData?.cameraModel}
					<div class="flex justify-between"><span>Modell</span><span class="text-text-primary">{probeData.cameraModel}</span></div>
				{/if}
				{#if probeData?.firmwareVersion}
					<div class="flex justify-between"><span>Firmware</span><span class="text-text-primary">{probeData.firmwareVersion}</span></div>
				{/if}
				{#if probeData?.codec}
					<div class="flex justify-between"><span>Codec</span><span class="text-text-primary">{probeData.codec}</span></div>
				{/if}
				{#if probeData?.liveFps}
					<div class="flex justify-between"><span>FPS</span><span class="text-text-primary">{probeData.liveFps}</span></div>
				{/if}
			</div>
			<!-- Protect status for native ONVIF -->
			{#if camera.protectConfigured}
				<div class="mt-3 pt-3 border-t border-border">
					<div class="flex items-center gap-2 mb-1.5">
						{#if camera.protectStatus?.isAdopted && camera.protectStatus?.state === 'CONNECTED'}
							<span class="w-2 h-2 rounded-full shrink-0 bg-green-400"></span>
							<span class="text-xs text-green-400 font-medium">In Protect adoptiert</span>
						{:else if camera.protectStatus?.isAdopted}
							<span class="w-2 h-2 rounded-full shrink-0 bg-red-400"></span>
							<span class="text-xs text-red-400 font-medium">Getrennt ({camera.protectStatus.state})</span>
						{:else}
							<span class="w-2 h-2 rounded-full shrink-0 bg-yellow-400"></span>
							<span class="text-xs text-yellow-400">Nicht in Protect</span>
						{/if}
					</div>
					{#if camera.protectStatus?.protectName}
						<div class="flex justify-between text-xs text-text-secondary"><span>Protect Name</span><span class="text-text-primary">{camera.protectStatus.protectName}</span></div>
					{/if}
				</div>
			{/if}
			<!-- Delete button for native ONVIF -->
			<div class="pt-2">
				{#if !showDeleteConfirm}
					<button onclick={() => showDeleteConfirm = true}
						class="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 cursor-pointer">
						<Trash2 class="w-3 h-3" /> Entfernen
					</button>
				{:else}
					<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
						<p class="text-xs text-red-400 mb-2">Kamera "{camera.name}" wirklich entfernen?</p>
						<div class="flex gap-2">
							<button onclick={deleteCamera} class="px-3 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600 cursor-pointer">Entfernen</button>
							<button onclick={() => showDeleteConfirm = false} class="px-3 py-1 text-xs bg-bg-input text-text-secondary rounded hover:bg-bg-card cursor-pointer">Abbrechen</button>
						</div>
					</div>
				{/if}
			</div>
		</div>
		{/if}
	</div>

	{#if !isNativeOnvif}
	<!-- Pipeline: horizontal flow with arrows -->
	<div class="p-4 border-t border-border {!isRunning ? 'opacity-40 pointer-events-none' : ''}">
		<div class="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-0 items-stretch">

			<!-- Kamera -->
			<div class="bg-bg-primary/50 rounded-lg px-3 py-2.5">
				<div class="flex items-center gap-2 mb-1.5">
					<span class="w-2 h-2 rounded-full shrink-0 {rebooting ? 'bg-yellow-400 animate-pulse' : camera.containerStatus === 'running' ? 'bg-green-400' : 'bg-red-400'}"></span>
					<span class="text-sm font-medium text-text-primary">{rebooting ? 'Neustart...' : 'Kamera'}</span>
				</div>
				<div class="space-y-0.5 text-xs text-text-secondary">
					<div class="flex justify-between"><span>Name</span><span class="text-text-primary">{camera.name}</span></div>
					<div class="flex justify-between"><span>Modell</span><span class="text-text-primary">{probeData?.cameraModel || camera.cameraType}</span></div>
					<div class="flex justify-between"><span>IP</span><span class="font-mono text-text-primary">{camera.cameraIp}</span></div>
					<div class="flex justify-between"><span>Video</span><span class="text-text-primary">{probeData?.codec || 'MJPEG'}</span></div>
					<div class="flex justify-between"><span>Audio</span><span class="text-text-primary">{camera.streamInfo?.audioCodec ? 'G.711 mulaw' : '—'}</span></div>
					{#if probeData?.firmwareVersion}
						<div class="flex justify-between"><span>FW</span><span class="text-text-primary">{probeData.firmwareVersion}</span></div>
					{/if}
				</div>
			</div>

			<!-- Arrow -->
			<div class="hidden md:flex items-center justify-center px-1 text-text-secondary/30 text-lg">&#9654;</div>

			<!-- go2rtc -->
			<div class="bg-bg-primary/50 rounded-lg px-3 py-2.5">
				<div class="flex items-center gap-2 mb-1.5">
					<span class="w-2 h-2 rounded-full shrink-0 {camera.go2rtcRunning ? 'bg-green-400' : 'bg-red-400'}"></span>
					<span class="text-sm font-medium text-text-primary">go2rtc</span>
					{#if camera.go2rtcRunning && camera.go2rtcWebUrl}
						<a href={camera.go2rtcWebUrl} target="_blank" class="text-accent hover:text-accent/80 ml-auto">
							<ExternalLink class="w-3.5 h-3.5" />
						</a>
					{/if}
				</div>
				<div class="space-y-0.5 text-xs text-text-secondary">
					<div class="flex justify-between"><span>Video</span><span class="text-text-primary">MJPEG → H.264 (VAAPI)</span></div>
					<div class="flex justify-between">
						<span>Audio</span>
						<span class="text-text-primary">
							{#if camera.streamInfo?.audioCodec}
								{camera.streamInfo.audioCodec}
							{:else}
								—
							{/if}
						</span>
					</div>
					<div class="flex justify-between">
						<span>FPS</span>
						<span class="text-text-primary">
							{#if probeData?.liveFps != null}
								{probeData.liveFps}
							{:else}
								—
							{/if}
						</span>
					</div>
					<div class="flex justify-between"><span>Bitrate</span><span class="text-text-primary">{camera.bitrate} kbit/s</span></div>
					<div class="flex justify-between"><span>Clients</span><span class="text-text-primary">{camera.connectedClients}</span></div>
				</div>
			</div>

			<!-- Arrow -->
			<div class="hidden md:flex items-center justify-center px-1 text-text-secondary/30 text-lg">&#9654;</div>

			<!-- ONVIF Server -->
			<div class="bg-bg-primary/50 rounded-lg px-3 py-2.5">
				<div class="flex items-center gap-2 mb-1.5">
					<span class="w-2 h-2 rounded-full shrink-0 {camera.onvifRunning ? 'bg-green-400' : 'bg-red-400'}"></span>
					<span class="text-sm font-medium text-text-primary">ONVIF</span>
				</div>
				<div class="space-y-0.5 text-xs text-text-secondary">
					<div class="flex justify-between"><span>Port</span><span class="font-mono text-text-primary">8899</span></div>
					<div class="flex justify-between"><span>Gerät</span><span class="text-text-primary">{camera.name}</span></div>
					<div class="flex justify-between"><span>Discovery</span><span class="{camera.onvifRunning ? 'text-green-400' : 'text-red-400'}">{camera.onvifRunning ? 'aktiv' : 'aus'}</span></div>
				</div>
			</div>

			<!-- Arrow -->
			<div class="hidden md:flex items-center justify-center px-1 text-text-secondary/30 text-lg">&#9654;</div>

			<!-- UniFi Protect -->
			<div class="bg-bg-primary/50 rounded-lg px-3 py-2.5">
				<div class="flex items-center gap-2 mb-1.5">
					{#if camera.protectStatus?.isAdopted && camera.protectStatus?.state === 'CONNECTED'}
						<span class="w-2 h-2 rounded-full shrink-0 bg-green-400"></span>
					{:else if camera.protectStatus?.isAdopted}
						<span class="w-2 h-2 rounded-full shrink-0 bg-red-400"></span>
					{:else if camera.protectConfigured}
						<span class="w-2 h-2 rounded-full shrink-0 bg-yellow-400"></span>
					{:else}
						<span class="w-2 h-2 rounded-full shrink-0 bg-gray-400"></span>
					{/if}
					<span class="text-sm font-medium text-text-primary">UniFi Protect</span>
					{#if camera.flapping}
						<span class="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium">instabil</span>
					{/if}
				</div>
				<div class="space-y-0.5 text-xs text-text-secondary">
					<div class="flex justify-between">
						<span>Status</span>
						{#if camera.protectStatus?.isAdopted && camera.protectStatus?.state === 'CONNECTED'}
							<span class="text-green-400 font-medium">Adoptiert</span>
						{:else if camera.protectStatus?.isAdopted}
							<span class="text-red-400 font-medium">Getrennt ({camera.protectStatus.state})</span>
						{:else if camera.protectConfigured}
							<span class="text-yellow-400">Nicht adoptiert</span>
						{:else}
							<span class="text-gray-400">Nicht konfiguriert</span>
						{/if}
					</div>
					{#if camera.protectStatus?.protectName}
						<div class="flex justify-between"><span>Protect Name</span><span class="text-text-primary">{camera.protectStatus.protectName}</span></div>
					{/if}
					{#if camera.protectStatus?.connectedSince}
						<div class="flex justify-between"><span>Verbunden seit</span><span class="text-text-primary">{new Date(camera.protectStatus.connectedSince).toLocaleString('de-DE')}</span></div>
					{/if}
					{#if camera.protectStatus?.isThirdPartyCamera}
						<div class="flex justify-between"><span>Typ</span><span class="text-text-primary">Third-Party</span></div>
					{/if}
					<div class="flex justify-between"><span>Codec</span><span class="text-text-primary">{(camera.streamInfo?.codec || 'H.264').replace('H264', 'H.264')}</span></div>
				</div>
				{#if camera.protectConfigured && !camera.protectStatus?.isAdopted}
					{#if camera.protectStatus}
						<!-- Discovered by Protect but not adopted yet — direct link -->
						<a
							href={camera.protectUrl}
							target="_blank"
							class="mt-2 text-xs px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors font-medium cursor-pointer w-full block text-center"
						>
							Jetzt in Protect übernehmen ↗
						</a>
					{:else}
						<!-- Not yet discovered by Protect -->
						<div class="mt-2 flex items-center gap-2 text-xs text-text-secondary">
							<span class="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0"></span>
							<span>Warte auf Protect-Erkennung...</span>
						</div>
					{/if}
				{/if}
			</div>
		</div>

		<!-- MJPEG URL bar — P22-UAT 2026-05-15. The MJPEG link the user can
		     paste into Loxone Intercom, dashboards, OBS, etc. For Mobotix the
		     cam-direct URL (no transcoding, native MJPEG); for cams augmented
		     by a Hub MJPEG output the bridge stream URL. -->
		{#if cameraMjpegUrl}
			<div class="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2">
				<span class="text-xs text-text-secondary shrink-0">MJPEG</span>
				<code class="text-xs text-text-primary font-mono flex-1 truncate">{cameraMjpegUrl}</code>
				<button onclick={copyMjpegUrl} class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer" title="MJPEG-URL kopieren">
					{#if mjpegUrlCopied}
						<Check class="w-4 h-4 text-green-400" />
					{:else}
						<Copy class="w-4 h-4" />
					{/if}
				</button>
			</div>
		{/if}

		<!-- RTSP URL bar — always the actually-usable URL.
		     When RTSP-Auth is off: plain rtsp://host:port/stream.
		     When RTSP-Auth is on:  rtsp://user:pw@host:port/stream (password masked on screen,
		     full URL copied to clipboard). The separate "RTSP+Auth" field was redundant. -->
		{#if camera.rtspUrl}
			<div class="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2 mt-3">
				<span class="text-xs text-text-secondary shrink-0">RTSP</span>
				<code class="text-xs text-text-primary font-mono flex-1 truncate">
					{camera.rtspAuthEnabled && authCreds && !authPwVisible ? rtspMaskedUrl : rtspDisplayUrl}
				</code>
				{#if camera.rtspAuthEnabled && authCreds}
					<button onclick={toggleAuthReveal} class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer" title={authPwVisible ? 'Passwort verbergen' : 'Passwort anzeigen'}>
						{#if authPwVisible}<EyeOff class="w-4 h-4" />{:else}<Eye class="w-4 h-4" />{/if}
					</button>
				{/if}
				<button onclick={copyRtsp} class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer" title={camera.rtspAuthEnabled ? 'Komplette URL mit Creds kopieren' : 'Kopieren'}>
					{#if copied}
						<Check class="w-4 h-4 text-green-400" />
					{:else}
						<Copy class="w-4 h-4" />
					{/if}
				</button>
			</div>

			<!-- Manuelle Protect-Adoption (ONVIF) -->
			{#if !isNativeOnvif && camera.containerIp}
				<div class="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2 mt-2">
					<span class="text-xs text-text-secondary shrink-0">ONVIF</span>
					<code class="text-xs text-text-primary font-mono flex-1 truncate">{camera.containerIp}:8899</code>
					<span class="text-[10px] text-text-secondary/70 shrink-0 hidden sm:inline" title="In UniFi Protect: Third-Party Cameras → ONVIF">
						{camera.rtspAuthEnabled ? 'für manuelle Adoption (Login unten)' : 'für manuelle Adoption (ohne Login)'}
					</span>
					<button onclick={copyOnvif} class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer" title="Kopieren">
						{#if onvifCopied}
							<Check class="w-4 h-4 text-green-400" />
						{:else}
							<Copy class="w-4 h-4" />
						{/if}
					</button>
				</div>

				<!-- RTSP-Auth: status + toggle + adoption credentials -->
				<div class="bg-bg-primary rounded-lg px-3 py-2.5 mt-2 space-y-2">
					<div class="flex items-center gap-2">
						{#if camera.rtspAuthEnabled}
							<Lock class="w-3.5 h-3.5 text-green-400 shrink-0" />
							<span class="text-xs text-text-primary font-medium">RTSP-Auth aktiv</span>
							<span class="text-[10px] text-text-secondary/70 hidden sm:inline">go2rtc prüft Creds beim Stream-Pull</span>
							<button
								onclick={() => setRtspAuth(false)}
								disabled={authLoading}
								class="ml-auto text-[10px] text-text-secondary hover:text-text-primary shrink-0 cursor-pointer disabled:opacity-50"
								title="RTSP-Auth deaktivieren"
							>
								deaktivieren
							</button>
						{:else}
							<LockOpen class="w-3.5 h-3.5 text-text-secondary/60 shrink-0" />
							<span class="text-xs text-text-secondary">RTSP-Auth aus</span>
							<span class="text-[10px] text-text-secondary/60 hidden sm:inline">Stream offen im LAN</span>
							<button
								onclick={() => setRtspAuth(true)}
								disabled={authLoading}
								class="ml-auto text-xs px-2 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25 shrink-0 cursor-pointer disabled:opacity-50 font-medium"
								title="Aktiviert go2rtc-Login mit den Kamera-Credentials. Protect muss danach neu adoptiert werden."
							>
								{authLoading ? '…' : 'aktivieren'}
							</button>
						{/if}
					</div>

					{#if authError}
						<div class="text-[11px] text-red-400">{authError}</div>
					{/if}
					{#if authToggleHint}
						<div class="text-[11px] text-yellow-400/90">{authToggleHint}</div>
					{/if}

					{#if camera.rtspAuthEnabled}
						{#if camera.cameraType === 'bambu'}
							<p class="text-[10px] text-text-secondary/80 pt-1 border-t border-white/5">
								In UniFi Protect: Third-Party → ONVIF → User <span class="font-mono text-text-primary">bambu</span>, Passwort = Access Code des Druckers.
							</p>
						{/if}
						<div class="flex items-center gap-2 {camera.cameraType === 'bambu' ? '' : 'pt-1 border-t border-white/5'}">
							<span class="text-[10px] text-text-secondary/70 shrink-0 w-14">User</span>
							<code class="text-xs text-text-primary font-mono flex-1 truncate">
								{authCreds?.username ?? (authLoading ? '…' : '')}
							</code>
							<button onclick={copyAuthUser} class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer" title="Benutzername kopieren">
								{#if authUserCopied}<Check class="w-3.5 h-3.5 text-green-400" />{:else}<Copy class="w-3.5 h-3.5" />{/if}
							</button>
						</div>
						<div class="flex items-center gap-2">
							<span class="text-[10px] text-text-secondary/70 shrink-0 w-14">Password</span>
							<code class="text-xs text-text-primary font-mono flex-1 truncate">
								{#if authPwVisible}
									{authCreds?.password ?? '…'}
								{:else}
									••••••••
								{/if}
							</code>
							<button onclick={toggleAuthReveal} class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer" title={authPwVisible ? 'Verbergen' : 'Anzeigen'}>
								{#if authPwVisible}<EyeOff class="w-3.5 h-3.5" />{:else}<Eye class="w-3.5 h-3.5" />{/if}
							</button>
							<button onclick={copyAuthPw} class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer" title="Passwort kopieren">
								{#if authPwCopied}<Check class="w-3.5 h-3.5 text-green-400" />{:else}<Copy class="w-3.5 h-3.5" />{/if}
							</button>
						</div>
						<!-- RTSP+Auth URL field removed — the top "RTSP" bar now shows the
						     full URL with credentials embedded (masked on screen, full
						     on copy) so there's a single source of truth per camera. -->
					{/if}
				</div>
			{/if}
		{/if}
	</div>
	{/if}

	<!-- P22-UAT 2026-05-15 — Protect Hub URLs (merged from external twin).
	     Renders only when this managed cam ALSO has a matching Hub output
	     (same protectId on both sides). User can then copy the Hub bridge
	     URL for external/Loxone/Frigate consumers alongside the LXC URL. -->
	{#if hubBridgeUrls && hubBridgeUrls.length > 0}
		<div class="border-t border-border px-4 py-3 bg-bg-primary/30">
			<div class="flex items-center gap-2 mb-2">
				<span class="bg-accent/15 text-accent border border-accent/30 px-2 py-0.5 rounded text-xs">
					Protect Hub
				</span>
				<span class="text-xs text-text-secondary">
					zusätzlicher Zugriff über die Bridge-LXC
				</span>
			</div>
			<div class="space-y-2">
				{#each hubBridgeUrls as h (h.outputType)}
					<div class="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2">
						<span class="text-xs text-text-secondary shrink-0 w-16">{h.outputType === 'loxone-mjpeg' ? 'MJPEG' : 'RTSP'}</span>
						<code class="text-xs text-text-primary font-mono flex-1 truncate" title={h.label}>
							{h.url}
						</code>
						<button
							onclick={() => copyHubUrl(h.url)}
							class="text-text-secondary hover:text-text-primary shrink-0 cursor-pointer"
							title={h.label}
						>
							{#if hubCopied === h.url}
								<Check class="w-4 h-4 text-green-400" />
							{:else}
								<Copy class="w-4 h-4" />
							{/if}
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<!-- Adoption Guide Modal -->
{#if showAdoptionGuide}
	<AdoptionGuide
		cameraId={camera.id}
		cameraName={camera.name}
		containerIp={camera.containerIp}
		cameraIp={camera.cameraIp}
		isNativeOnvif={isNativeOnvif}
		onClose={() => showAdoptionGuide = false}
	/>
{/if}

<!-- Credentials Modal -->
{#if showCredentials}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onclick={(e) => { if (e.target === e.currentTarget) showCredentials = false; }}>
		<div class="bg-bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5">
			<h3 class="text-text-primary font-bold text-sm mb-1">Zugangsdaten — {camera.name}</h3>
			<p class="text-text-secondary text-xs mb-4">{camera.cameraIp} ({camera.cameraType})</p>

			{#if credSuccess}
				<div class="flex items-center gap-2 text-success text-sm py-4 justify-center">
					<Check class="w-5 h-5" />
					<span>Gespeichert und verifiziert</span>
				</div>
			{:else}
				<div class="space-y-3">
					<div>
						<label for="cred-user" class="block text-xs text-text-secondary mb-1">Benutzername</label>
						<input id="cred-user" type="text" bind:value={credUsername} placeholder="admin"
							class="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 outline-none focus:border-accent" />
					</div>
					<div>
						<label for="cred-pass" class="block text-xs text-text-secondary mb-1">Passwort</label>
						<input id="cred-pass" type="password" bind:value={credPassword}
							onkeydown={(e) => { if (e.key === 'Enter' && credUsername && credPassword) saveCredentials(); }}
							class="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent" />
					</div>

					{#if credError}
						<div class="bg-danger/10 border border-danger/30 rounded-lg px-3 py-2 text-xs text-danger">{credError}</div>
					{/if}

					<div class="flex gap-2 pt-1">
						<button onclick={saveCredentials} disabled={credLoading || !credUsername || !credPassword}
							class="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
							{#if credLoading}
								<Loader2 class="w-4 h-4 animate-spin" /> Teste...
							{:else}
								Testen & Speichern
							{/if}
						</button>
						<button onclick={() => showCredentials = false}
							class="px-3 py-2 text-sm bg-bg-input text-text-secondary rounded-lg hover:bg-bg-primary cursor-pointer">
							Abbrechen
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
