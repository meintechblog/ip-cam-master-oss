<script lang="ts">
	// v1.3 Phase 19 Plan 04 — Settings "Protect Hub" tab content.
	// Renders the read-only catalog (HUB-CAT-01..06) populated by
	// POST /api/protect-hub/discover (Plan 03). Auto-discovers on
	// first visit when cache is empty (D-REFRESH-01); manual refresh
	// otherwise. Falls back to cached display + orange banner on
	// controller_unreachable (HUB-CAT-05).
	//
	// v1.3 Phase 22 Plan 05 — Embeds <HubStatusPanel> + <HubEventLog>
	// (HUB-UI-08) and wires the L-18 toggle-flap-protection (SC-4):
	// while hubState ∈ {starting, stopping}, the "Protect Hub aktivieren"
	// toggle is disabled, an inline Loader2 + "Vorgang läuft…" caption
	// renders, and a separate "Abbrechen" button POSTs to
	// /api/protect-hub/wizard/reset (the only abort path per L-18).
	//
	// HUB-WIZ-01 boundary: this tab is the ENTRY POINT, not the wizard.
	// The wizard lives at /settings/protect-hub/onboarding (P20+P22).
	import {
		RefreshCw,
		AlertTriangle,
		ExternalLink,
		Loader2,
		ShieldCheck,
		ShieldQuestion,
		Building2,
		Server,
		Play,
		Square,
		RotateCcw,
		Share2
	} from 'lucide-svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import HubStatusPanel from '$lib/components/protect-hub/HubStatusPanel.svelte';
	import HubEventLog from '$lib/components/protect-hub/HubEventLog.svelte';

	// Mirror of the union exported by hub-state.ts. Duplicated locally
	// so this file stays browser-safe (no `$lib/server/*` imports leak
	// into the client bundle).
	type HubState = 'disabled' | 'starting' | 'enabled' | 'stopping' | 'error';

	let { hub, hubState, switchTab } = $props<{
		hub: {
			enabled: boolean;
			credsConfigured: boolean;
			cams: Array<{
				id: number;
				name: string;
				mac: string | null;
				manufacturer: string | null;
				modelName: string | null;
				kind: string;
				status: string;
			}>;
			catalogByCamId: Record<
				number,
				Array<{
					quality: string;
					codec: string | null;
					width: number | null;
					height: number | null;
					fps: number | null;
					bitrate: number | null;
				}>
			>;
			lastDiscoveredAt: number | null;
			bridge: {
				id: number;
				vmid: number;
				hostname: string;
				containerIp: string | null;
				status: string;
				lastHealthCheckAt: string | null;
			} | null;
		};
		hubState: HubState;
		switchTab: (tab: string) => void;
	}>();

	// v1.3 Phase 22 Plan 05 — L-18 toggle-flap-protection (SC-4).
	const toggleDisabled = $derived(hubState === 'starting' || hubState === 'stopping');
	let cancelInFlight = $state(false);

	async function cancelTransition() {
		cancelInFlight = true;
		try {
			await fetch('/api/protect-hub/wizard/reset', { method: 'POST' });
			await invalidateAll();
		} finally {
			cancelInFlight = false;
		}
	}

	async function onToggle() {
		// Off → On flips the user into the wizard (which atomically saves
		// protect_hub_enabled='true' on Step 6 via /wizard/complete). Off-flow
		// (full unwind) is owned by P23 — render a no-op for now when enabled.
		if (hub.enabled) {
			// Disabling lives in P23 — keep this a no-op surface. The toggle
			// remains visually "on" until P23 lands.
			return;
		}
		await goto('/settings/protect-hub/onboarding');
	}

	let bridgeLoading = $state(false);

	async function bridgeAction(action: 'start' | 'stop' | 'restart') {
		bridgeLoading = true;
		try {
			await fetch(`/api/protect-hub/bridge/${action}`, { method: 'POST' });
			await invalidateAll();
		} finally {
			bridgeLoading = false;
		}
	}

	function bridgeStatusBadge(status: string): { color: string; label: string; spinning: boolean } {
		switch (status) {
			case 'running':
				return { color: 'bg-green-500', label: 'Läuft', spinning: false };
			case 'stopped':
				return { color: 'bg-yellow-500', label: 'Gestoppt', spinning: false };
			case 'failed':
				return { color: 'bg-red-500', label: 'Fehlgeschlagen', spinning: false };
			case 'provisioning':
				return { color: 'bg-blue-500', label: 'Wird bereitgestellt...', spinning: true };
			default:
				return { color: 'bg-gray-500', label: 'Ausstehend', spinning: false };
		}
	}

	let refreshing = $state(false);
	let unreachable = $state(false);
	let authFailed = $state(false);
	let errorMessage = $state<string | null>(null);
	let autoDiscoverFired = $state(false);

	async function refresh() {
		refreshing = true;
		unreachable = false;
		authFailed = false;
		errorMessage = null;
		try {
			const res = await fetch('/api/protect-hub/discover', { method: 'POST' });
			const body = await res.json();
			if (!res.ok || !body.ok) {
				if (body.reason === 'controller_unreachable') unreachable = true;
				else if (body.reason === 'auth_failed') authFailed = true;
				else errorMessage = body.error || 'Aktualisierung fehlgeschlagen';
			}
			await invalidateAll();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Netzwerkfehler';
		} finally {
			refreshing = false;
		}
	}

	// D-REFRESH-01: auto-discover on first visit when cache is empty.
	// `autoDiscoverFired` guard prevents repeated fires if the discover()
	// call returns 0 cams (avoids effect re-run loop after invalidateAll).
	$effect(() => {
		if (
			!autoDiscoverFired &&
			hub.credsConfigured &&
			hub.cams.length === 0 &&
			!refreshing &&
			!errorMessage &&
			!unreachable &&
			!authFailed
		) {
			autoDiscoverFired = true;
			refresh();
		}
	});

	function lastDiscoveredText(): string {
		if (hub.lastDiscoveredAt === null) return 'noch nie';
		return new Date(hub.lastDiscoveredAt).toLocaleString('de-DE');
	}
</script>

<div class="max-w-4xl space-y-6">
	{#if !hub.credsConfigured}
		<!-- Q-OPEN-04 / no-creds branch: deep-link to UniFi tab -->
		<div class="bg-yellow-500/10 border border-yellow-500/30 px-4 py-3 rounded">
			<p class="text-text-primary mb-2">
				Konfiguriere zuerst die UniFi-Verbindung, um den Protect Hub zu nutzen.
			</p>
			<button
				class="inline-flex items-center gap-2 px-3 py-1.5 bg-accent text-white rounded
					hover:bg-accent/90 transition-colors"
				onclick={() => switchTab('UniFi')}
			>
				Zur UniFi-Konfiguration <ExternalLink class="h-4 w-4" />
			</button>
		</div>
	{:else}
		<!-- v1.3 Phase 22 Plan 05 — "Protect Hub aktivieren" toggle (SC-4 L-18 surface).
			 Disabled with inline Loader2 + "Vorgang läuft…" caption and a separate
			 "Abbrechen" button when hubState ∈ {starting, stopping}. -->
		<div class="bg-bg-card rounded-lg border border-border p-6">
			<div class="flex items-center gap-3">
				<button
					type="button"
					role="switch"
					aria-checked={hub.enabled}
					aria-disabled={toggleDisabled}
					disabled={toggleDisabled}
					onclick={onToggle}
					class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors
						{hub.enabled ? 'bg-accent' : 'bg-bg-input'}
						disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
				>
					<span
						class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform
							{hub.enabled ? 'translate-x-6' : 'translate-x-1'}"
					></span>
				</button>
				<span class="text-sm text-text-primary font-medium">Protect Hub aktivieren</span>

				{#if toggleDisabled}
					<Loader2 class="w-4 h-4 animate-spin text-accent" />
					<span class="text-xs text-text-secondary">Vorgang läuft…</span>
					<button
						type="button"
						onclick={cancelTransition}
						disabled={cancelInFlight}
						class="text-xs text-text-secondary hover:text-danger disabled:opacity-60 disabled:cursor-not-allowed"
					>
						Abbrechen
					</button>
				{/if}
			</div>
		</div>

		<!-- "Why" intro card: erklärt Zweck des Hub + konkrete Use-Cases (Loxone, Frigate, …) -->
		<div class="bg-bg-card rounded-lg border border-border p-6">
			<div class="flex items-start gap-3">
				<div class="rounded bg-accent/10 p-2 text-accent flex-shrink-0">
					<Share2 class="w-5 h-5" />
				</div>
				<div class="space-y-3">
					<div>
						<h2 class="text-lg font-semibold text-text-primary">
							Wofür ist der Protect Hub?
						</h2>
						<p class="text-sm text-text-secondary mt-1">
							Stellt deine UniFi-Protect-Kameras über einen einzigen LXC-Bridge-Container in
							Formaten bereit, die andere Tools verstehen — pro Cam wahlweise mehrere Outputs
							gleichzeitig. Du musst dafür keine Cam neu anschließen; der Hub greift auf die in
							Protect bereits adoptierten Streams zurück und teilt sie im LAN weiter.
						</p>
					</div>
					<ul class="text-sm space-y-2">
						<li class="flex gap-2">
							<span class="text-accent flex-shrink-0">→</span>
							<span class="text-text-secondary">
								<span class="text-text-primary font-medium">Loxone Intercom</span> — Protect-Cam
								auf der Türstation-Kachel ("Benutzerdefinierte Intercom") in der Loxone-App
								anzeigen. Hub liefert MJPEG bei 640×360 @ 10 fps direkt aus dem Bridge-Container.
							</span>
						</li>
						<li class="flex gap-2">
							<span class="text-accent flex-shrink-0">→</span>
							<span class="text-text-secondary">
								<span class="text-text-primary font-medium">Frigate, Home Assistant, NVRs</span> —
								nativer H.264-RTSP-Passthrough ohne Re-Encoding, volle Auflösung, keine VAAPI-Last.
							</span>
						</li>
						<li class="flex gap-2">
							<span class="text-accent flex-shrink-0">→</span>
							<span class="text-text-secondary">
								<span class="text-text-primary font-medium">Sonstige Tools</span> — alles, was
								MJPEG-HTTP oder RTSP konsumiert (Browser-Embed, Synology, ältere NVR-Software).
							</span>
						</li>
					</ul>
				</div>
			</div>
		</div>

		<!-- Bridge status panel (P20) -->
		{#if hub.bridge === null}
			<div class="bg-bg-card rounded-lg border border-border p-6">
				<div class="flex items-center gap-3 mb-3">
					<Server class="w-5 h-5 text-text-secondary" />
					<h2 class="text-lg font-semibold text-text-primary">Bridge-Container</h2>
				</div>
				<p class="text-sm text-text-secondary mb-4">
					Kein Bridge-Container vorhanden. Richte einen ein, um Protect-Streams über go2rtc bereitzustellen.
				</p>
				<button
					onclick={() => goto('/settings/protect-hub/onboarding')}
					class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded font-medium
						hover:bg-accent/90 transition-colors cursor-pointer"
				>
					<Server class="w-4 h-4" />
					Bridge einrichten
				</button>
			</div>
		{:else}
			{@const badge = bridgeStatusBadge(hub.bridge.status)}
			<div class="bg-bg-card rounded-lg border border-border p-6">
				<div class="flex items-center gap-3 mb-4">
					<Server class="w-5 h-5 text-text-secondary" />
					<h2 class="text-lg font-semibold text-text-primary">Bridge-Container</h2>
					<div class="flex items-center gap-2 ml-auto">
						{#if badge.spinning}
							<Loader2 class="w-3.5 h-3.5 animate-spin text-blue-400" />
						{:else}
							<span class="w-2.5 h-2.5 rounded-full {badge.color}"></span>
						{/if}
						<span class="text-sm font-medium {hub.bridge.status === 'running' ? 'text-green-400' : hub.bridge.status === 'failed' ? 'text-red-400' : 'text-text-secondary'}">
							{badge.label}
						</span>
					</div>
				</div>

				<div class="grid grid-cols-2 gap-4 mb-4 text-sm">
					<div>
						<span class="text-text-secondary">Hostname</span>
						<p class="font-mono text-text-primary">{hub.bridge.hostname}</p>
					</div>
					<div>
						<span class="text-text-secondary">VMID</span>
						<p class="font-mono text-text-primary">{hub.bridge.vmid}</p>
					</div>
					{#if hub.bridge.containerIp}
						<div>
							<span class="text-text-secondary">Container-IP</span>
							<p class="font-mono text-text-primary">{hub.bridge.containerIp}</p>
						</div>
					{/if}
					<div>
						<span class="text-text-secondary">Letzter Health-Check</span>
						<p class="font-mono text-text-primary">
							{hub.bridge.lastHealthCheckAt
								? new Date(hub.bridge.lastHealthCheckAt).toLocaleString('de-DE')
								: 'noch nie'}
						</p>
					</div>
				</div>

				<div class="flex items-center gap-2">
					{#if hub.bridge.status === 'stopped' || hub.bridge.status === 'failed' || hub.bridge.status === 'pending'}
						<button
							onclick={() => bridgeAction('start')}
							disabled={bridgeLoading}
							class="inline-flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded
								hover:bg-green-700 transition-colors text-sm font-medium cursor-pointer disabled:opacity-50"
						>
							<Play class="w-3.5 h-3.5" />
							Starten
						</button>
					{/if}
					{#if hub.bridge.status === 'running'}
						<button
							onclick={() => bridgeAction('stop')}
							disabled={bridgeLoading}
							class="inline-flex items-center gap-2 px-3 py-1.5 bg-yellow-600 text-white rounded
								hover:bg-yellow-700 transition-colors text-sm font-medium cursor-pointer disabled:opacity-50"
						>
							<Square class="w-3.5 h-3.5" />
							Stoppen
						</button>
						<button
							onclick={() => bridgeAction('restart')}
							disabled={bridgeLoading}
							class="inline-flex items-center gap-2 px-3 py-1.5 border border-border text-text-secondary rounded
								hover:text-text-primary hover:bg-bg-input transition-colors text-sm font-medium cursor-pointer disabled:opacity-50"
						>
							<RotateCcw class="w-3.5 h-3.5" />
							Neustarten
						</button>
					{/if}
					{#if bridgeLoading}
						<Loader2 class="w-4 h-4 animate-spin text-text-secondary" />
					{/if}
				</div>
			</div>
		{/if}

		<!-- v1.3 Phase 22 Plan 05 — Hub-Status + Event-Log panels (HUB-UI-08). -->
		<HubStatusPanel />
		<HubEventLog />

		<!-- Status + refresh card -->
		<div class="bg-bg-card rounded-lg border border-border p-6">
			<h2 class="text-lg font-semibold text-text-primary mb-2">
				Protect Hub — Stream-Katalog
			</h2>
			<p class="text-sm text-text-secondary mb-4">
				Letzte Aktualisierung: <span class="font-mono">{lastDiscoveredText()}</span>
				· Erfasste Kameras: <span class="font-mono">{hub.cams.length}</span>
			</p>
			<button
				onclick={refresh}
				disabled={refreshing}
				class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded font-medium
					hover:bg-accent/90 transition-colors disabled:opacity-50"
			>
				<RefreshCw class="w-4 h-4 {refreshing ? 'animate-spin' : ''}" />
				Aktualisieren
			</button>
		</div>

		<!-- HUB-CAT-05: controller-unreachable banner (cache fallback) -->
		{#if unreachable}
			<div
				class="bg-orange-500/10 border border-orange-500/30 text-orange-300 px-4 py-3 rounded
					flex items-start gap-2"
			>
				<AlertTriangle class="w-5 h-5 flex-shrink-0 mt-0.5" />
				<div>
					<p class="font-medium">Controller nicht erreichbar — Anzeige aus Cache</p>
					<p class="text-sm">Letzte Aktualisierung: {lastDiscoveredText()}</p>
				</div>
			</div>
		{/if}
		{#if authFailed}
			<div
				class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded"
			>
				Anmeldung bei UniFi fehlgeschlagen. Bitte Zugangsdaten prüfen → UniFi-Tab.
			</div>
		{/if}
		{#if errorMessage}
			<div
				class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded"
			>
				{errorMessage}
			</div>
		{/if}

		<!-- Catalog body -->
		{#if refreshing && hub.cams.length === 0}
			<div class="flex items-center gap-3 text-text-secondary py-8">
				<Loader2 class="w-5 h-5 animate-spin" />
				<span>Kamerakatalog wird geladen...</span>
			</div>
		{:else if hub.cams.length === 0}
			<p class="text-text-secondary text-sm">
				Noch keine Protect-Kameras gefunden. Klicke auf "Aktualisieren".
			</p>
		{:else}
			<div class="bg-bg-card rounded-lg border border-border overflow-hidden">
				<table class="w-full text-sm">
					<thead class="bg-bg-darker">
						<tr class="text-left text-text-secondary text-xs uppercase">
							<th class="px-4 py-2">Cam</th>
							<th class="px-4 py-2">Hersteller</th>
							<th class="px-4 py-2">Modell</th>
							<th class="px-4 py-2">MAC</th>
							<th class="px-4 py-2">Klassifizierung</th>
							<th class="px-4 py-2">Streams</th>
						</tr>
					</thead>
					<tbody>
						{#each hub.cams as cam (cam.id)}
							<tr class="border-t border-border align-top">
								<td class="px-4 py-3 font-medium">{cam.name}</td>
								<td class="px-4 py-3">{cam.manufacturer ?? '?'}</td>
								<td class="px-4 py-3">{cam.modelName ?? '?'}</td>
								<td class="px-4 py-3 font-mono text-xs">{cam.mac ?? '?'}</td>
								<td class="px-4 py-3">
									{#if cam.kind === 'first-party'}
										<span
											class="inline-flex items-center gap-1 px-2 py-0.5
												bg-blue-500/15 border border-blue-500/30 text-blue-300
												rounded text-xs"
										>
											<ShieldCheck class="w-3 h-3" /> first-party
										</span>
									{:else if cam.kind === 'third-party'}
										<span
											class="inline-flex items-center gap-1 px-2 py-0.5
												bg-purple-500/15 border border-purple-500/30 text-purple-300
												rounded text-xs"
										>
											<Building2 class="w-3 h-3" /> third-party
										</span>
									{:else}
										<span
											class="inline-flex items-center gap-1 px-2 py-0.5
												bg-gray-500/15 border border-gray-500/30 text-gray-300
												rounded text-xs"
										>
											<ShieldQuestion class="w-3 h-3" /> unbekannt
										</span>
									{/if}
								</td>
								<td class="px-4 py-3 space-y-1">
									<!-- HUB-CAT-06: one row per actual channel; never assume 3 -->
									{#each hub.catalogByCamId[cam.id] ?? [] as ch}
										<div class="text-xs font-mono">
											<span class="font-medium">{ch.quality}</span>
											{#if ch.codec}· {ch.codec}{/if}
											{#if ch.width && ch.height}· {ch.width}×{ch.height}{/if}
											{#if ch.fps}@ {ch.fps}fps{/if}
											{#if ch.bitrate}· {Math.round(ch.bitrate / 1000)} kbps{/if}
										</div>
									{:else}
										<span class="text-text-secondary text-xs">keine Streams</span>
									{/each}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</div>
