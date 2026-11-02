<script lang="ts">
	// Debug-Platform Tier-1 #1 — minimal read-only per-camera health panel.
	// Renders GET /api/cameras/[id]/debug as a 6-layer status list with a
	// status dot per layer + recent events. Auto-refreshes every 5s. Display
	// only — no destructive actions. This is the deliberately-plain first
	// increment; visual iteration happens with operator feedback.
	import { page } from '$app/state';
	import { onMount, onDestroy } from 'svelte';
	import { RefreshCw, ArrowLeft, Loader2 } from 'lucide-svelte';
	import type { CameraDebugHealth } from '$lib/types';

	const id = page.params.id;
	const REFRESH_MS = 5000;

	let data = $state<CameraDebugHealth | null>(null);
	let loadError = $state<string | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		refreshing = true;
		try {
			const res = await fetch(`/api/cameras/${id}/debug`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				loadError = body?.error ?? `HTTP ${res.status}`;
			} else {
				data = (await res.json()) as CameraDebugHealth;
				loadError = null;
			}
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Netzwerkfehler';
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	onMount(() => {
		load();
		timer = setInterval(load, REFRESH_MS);
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	type Dot = 'green' | 'red' | 'amber' | 'gray';
	const dotClass: Record<Dot, string> = {
		green: 'bg-emerald-500',
		red: 'bg-red-500',
		amber: 'bg-amber-500',
		gray: 'bg-white/25'
	};

	// Per-layer status → dot color. Kept explicit per layer so the meaning of
	// each colour is obvious at the call site rather than hidden in a helper.
	function deviceDot(l: CameraDebugHealth['layers']['device']): Dot {
		if (!l.applicable) return 'gray';
		return l.reachable ? 'green' : 'red';
	}
	function go2rtcDot(l: CameraDebugHealth['layers']['go2rtc']): Dot {
		if (!l.reachable) return 'red';
		if (!l.streamFound || l.producersStarted < 1) return 'amber';
		return 'green';
	}
	function onvifDot(l: CameraDebugHealth['layers']['onvif']): Dot {
		if (!l.applicable) return 'gray';
		return l.reachable ? 'green' : 'red';
	}
	function protectDot(l: CameraDebugHealth['layers']['protect']): Dot {
		if (!l.matched) return 'gray';
		if (l.phantom) return 'red';
		return l.state === 'CONNECTED' ? 'green' : 'amber';
	}
	function snapshotDot(l: CameraDebugHealth['layers']['snapshot']): Dot {
		if (!l) return 'gray';
		if (l.status === 'healthy') return 'green';
		return 'red';
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(1)} ${units[i]}`;
	}

	const sevClass: Record<string, string> = {
		error: 'text-red-400',
		warning: 'text-amber-400',
		info: 'text-white/60'
	};
</script>

<svelte:head><title>Debug · {data?.camera.name ?? `Cam ${id}`}</title></svelte:head>

<div class="mx-auto max-w-2xl px-4 py-6 text-white">
	<!-- Header -->
	<div class="mb-5 flex items-center justify-between gap-3">
		<div class="flex items-center gap-3">
			<a href="/kameras" class="text-white/50 transition hover:text-white" aria-label="Zurück zu Kameras">
				<ArrowLeft class="h-5 w-5" />
			</a>
			<div>
				<h1 class="text-lg font-semibold leading-tight">
					{data?.camera.name ?? `Kamera ${id}`}
				</h1>
				{#if data}
					<p class="text-xs text-white/40">
						{data.camera.cameraType ?? '—'} · {data.camera.streamName} · vmid {data.camera.vmid}
					</p>
				{/if}
			</div>
		</div>
		<button
			onclick={load}
			disabled={refreshing}
			class="flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1.5 text-xs text-white/70 transition hover:bg-white/5 disabled:opacity-50"
		>
			<RefreshCw class="h-3.5 w-3.5 {refreshing ? 'animate-spin' : ''}" />
			Aktualisieren
		</button>
	</div>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-white/50">
			<Loader2 class="h-4 w-4 animate-spin" /> Lade Health-Daten…
		</div>
	{:else if loadError}
		<div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
			{loadError}
		</div>
	{:else if data}
		<!-- 6-layer status list -->
		<div class="divide-y divide-white/10 rounded-lg border border-white/10 bg-white/[0.02]">
			<!-- Device -->
			<div class="flex items-start gap-3 px-4 py-3">
				<span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full {dotClass[deviceDot(data.layers.device)]}"></span>
				<div class="min-w-0 flex-1">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium">Kamera-Gerät</span>
						<span class="text-xs text-white/40">
							{data.layers.device.applicable ? (data.layers.device.reachable ? 'erreichbar' : 'nicht erreichbar') : 'n/a'}
						</span>
					</div>
					{#if data.layers.device.detail}
						<p class="text-xs text-white/40">{data.layers.device.detail}</p>
					{/if}
					{#if data.layers.device.error}
						<p class="text-xs text-red-400/80">{data.layers.device.error}</p>
					{/if}
				</div>
			</div>

			<!-- go2rtc -->
			<div class="flex items-start gap-3 px-4 py-3">
				<span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full {dotClass[go2rtcDot(data.layers.go2rtc)]}"></span>
				<div class="min-w-0 flex-1">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium">go2rtc</span>
						<span class="text-xs text-white/40">{data.layers.go2rtc.reachable ? 'erreichbar' : 'nicht erreichbar'}</span>
					</div>
					<p class="text-xs text-white/40">
						producers {data.layers.go2rtc.producersStarted}{data.layers.go2rtc.producersConfigured != null
							? `/${data.layers.go2rtc.producersConfigured}`
							: ''} · consumers {data.layers.go2rtc.consumers} · recv {fmtBytes(data.layers.go2rtc.bytesRecv)}
					</p>
					{#if data.layers.go2rtc.error}
						<p class="text-xs text-red-400/80">{data.layers.go2rtc.error}</p>
					{/if}
				</div>
			</div>

			<!-- ONVIF -->
			<div class="flex items-start gap-3 px-4 py-3">
				<span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full {dotClass[onvifDot(data.layers.onvif)]}"></span>
				<div class="min-w-0 flex-1">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium">ONVIF-Bridge</span>
						<span class="text-xs text-white/40">
							{data.layers.onvif.applicable ? (data.layers.onvif.reachable ? 'erreichbar' : 'nicht erreichbar') : 'n/a'}
						</span>
					</div>
					{#if data.layers.onvif.error}
						<p class="text-xs text-red-400/80">{data.layers.onvif.error}</p>
					{/if}
				</div>
			</div>

			<!-- Protect -->
			<div class="flex items-start gap-3 px-4 py-3">
				<span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full {dotClass[protectDot(data.layers.protect)]}"></span>
				<div class="min-w-0 flex-1">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium">UniFi Protect</span>
						<span class="text-xs text-white/40">{data.layers.protect.matched ? data.layers.protect.state : 'kein Match'}</span>
					</div>
					{#if data.layers.protect.matched}
						<p class="text-xs text-white/40">
							recording_end_age {data.layers.protect.recordingEndAgeSeconds}s · last_seen {data.layers.protect.lastSeenAgeSeconds}s{data
								.layers.protect.phantom
								? ' · ⚠ phantom-adoption'
								: ''}
						</p>
					{/if}
				</div>
			</div>

			<!-- Snapshot (stream_health) -->
			<div class="flex items-start gap-3 px-4 py-3">
				<span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full {dotClass[snapshotDot(data.layers.snapshot)]}"></span>
				<div class="min-w-0 flex-1">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium">Sampler-Snapshot</span>
						<span class="text-xs text-white/40">{data.layers.snapshot ? data.layers.snapshot.status : 'keine Daten'}</span>
					</div>
					{#if data.layers.snapshot}
						<p class="text-xs text-white/40">
							producer {data.layers.snapshot.producerAlive ? 'alive' : 'dead'} · consumers {data.layers.snapshot.consumers} · zuletzt
							{new Date(data.layers.snapshot.lastProbedAt).toLocaleTimeString('de-DE')}
						</p>
					{/if}
				</div>
			</div>
		</div>

		<!-- Recent events -->
		<h2 class="mb-2 mt-6 text-sm font-semibold text-white/70">Letzte Ereignisse</h2>
		{#if data.recentEvents.length === 0}
			<p class="text-xs text-white/40">Keine Ereignisse.</p>
		{:else}
			<ul class="space-y-1.5">
				{#each data.recentEvents as ev (ev.id)}
					<li class="flex items-baseline gap-2 text-xs">
						<span class="shrink-0 text-white/30">{new Date(ev.timestamp).toLocaleString('de-DE')}</span>
						<span class="shrink-0 font-medium {sevClass[ev.severity] ?? 'text-white/60'}">{ev.eventType}</span>
						<span class="truncate text-white/50">{ev.message}</span>
					</li>
				{/each}
			</ul>
		{/if}

		<p class="mt-5 text-[11px] text-white/25">
			Stand {new Date(data.probedAt).toLocaleTimeString('de-DE')} · Auto-Refresh alle {REFRESH_MS / 1000}s
		</p>
	{/if}
</div>
