<script lang="ts">
	// Quick-task 260610-cw6 — C4 lean detection LiveView. Client-driven (no
	// +page.server.ts): mirrors the logs/JournalTab client-SSE pattern exactly.
	// Seeds from /api/detections/status, then live-updates via the /api/detections/live
	// SSE (`status` + `detection` named events). Local-first: renders only MinimalEvent
	// fields. With no Protect creds the status route returns 200 disconnected/empty and
	// the page shows a clean "Nicht verbunden" banner — no spinner-forever, no error.
	//
	// + live snapshot panel (2026-06-10): a camera picker + ~1fps snapshot of the
	//   selected camera (pulled locally from Protect) so a detection can be watched
	//   against the actual picture. Image is served only to the LAN-bound UI.
	import DetectionHealthBanner from '$lib/components/detection/DetectionHealthBanner.svelte';
	import DetectionFeedItem from '$lib/components/detection/DetectionFeedItem.svelte';
	import type { DetectionStatus } from '$lib/server/services/detection-service';
	import type { MinimalEvent } from '$lib/server/services/detection-tap-fsm';
	import type { ConnState } from '$lib/server/services/protect-connection-fsm';

	type CamOption = { id: string; name: string; smartDetect: boolean };

	let connectionState = $state<ConnState>('disconnected');
	let lastEventAt = $state<number | null>(null);
	let feed = $state<MinimalEvent[]>([]);
	let cameras = $state<CamOption[]>([]);
	let selectedId = $state<string>('');
	let imgTick = $state(0);
	// Reactive wall-clock, ticked every second, so time-window derivations (the live
	// detection badge) re-evaluate and CLEAR even when no new event arrives. Without
	// this, a `$derived` reading Date.now() only re-runs on feed/selection changes,
	// leaving a stale "erkannt" badge lit long after the subject left.
	let nowMs = $state(Date.now());
	let imgFailed = $state(false);
	let source: EventSource | null = null;

	function applyStatus(s: DetectionStatus) {
		connectionState = s.connectionState;
		lastEventAt = s.lastEventAt;
		// status.recent is already NEWEST-FIRST, bounded to 50.
		feed = s.recent ?? [];
	}

	const nameById = $derived(new Map(cameras.map((c) => [c.id, c.name] as const)));
	function camName(id: string): string {
		return nameById.get(id) ?? id;
	}

	// "Live hit" badge over the image. feed is newest-first, so the first entry for the
	// selected camera is its most recent event. Show the badge ONLY when that most
	// recent event is a still-open 'confirmed' (an 'ended' means the subject left →
	// hide immediately) AND it is fresh (< 5s, via the ticking nowMs so it self-clears
	// during a lull). This fixes the stale "Person erkannt" that lingered with nobody
	// on camera.
	const latestForCam = $derived(selectedId ? feed.find((e) => e.camera === selectedId) : undefined);
	const liveHit = $derived(
		latestForCam && latestForCam.phase === 'confirmed' && nowMs - latestForCam.ts < 5000
			? latestForCam
			: undefined
	);

	$effect(() => {
		let cancelled = false;

		// Camera list (id→name + snapshot targets).
		(async () => {
			try {
				const res = await fetch('/api/detections/cameras');
				if (!res.ok) return;
				const data = (await res.json()) as { ok: boolean; cameras?: CamOption[] };
				if (cancelled || !data.ok || !data.cameras) return;
				cameras = data.cameras;
				if (!selectedId && cameras.length) selectedId = cameras[0].id;
			} catch {
				/* leave empty — picker just won't render */
			}
		})();

		// (1) Seed from the JSON status surface. Guarded so a fetch failure still
		//     renders the disconnected state — never an error screen.
		(async () => {
			try {
				const res = await fetch('/api/detections/status');
				if (!res.ok) return;
				const data = (await res.json()) as DetectionStatus;
				if (!cancelled) applyStatus(data);
			} catch {
				/* leave disconnected/empty defaults — the banner carries the message */
			}
		})();

		// (2) Live SSE. EventSource auto-reconnects; we reflect transient errors as
		//     'degraded' so the banner shows "Wiederverbindung läuft" until the next
		//     replayed `status` event (or reconnect) corrects it.
		source = new EventSource('/api/detections/live');

		source.addEventListener('status', (e: MessageEvent) => {
			try {
				applyStatus(JSON.parse(e.data) as DetectionStatus);
			} catch {
				/* skip malformed frame */
			}
		});

		source.addEventListener('detection', (e: MessageEvent) => {
			try {
				const ev = JSON.parse(e.data) as MinimalEvent;
				feed = [ev, ...feed].slice(0, 50);
				lastEventAt = ev.ts;
			} catch {
				/* skip malformed frame */
			}
		});

		source.onerror = () => {
			// Transient — reflect a reconnecting state; the next status/open corrects it.
			connectionState = 'degraded';
		};

		return () => {
			cancelled = true;
			source?.close();
			source = null;
		};
	});

	// ~1 fps snapshot refresh while a camera is selected and the tap is connected.
	$effect(() => {
		if (!selectedId || connectionState === 'disconnected') return;
		const t = setInterval(() => {
			imgTick++;
			nowMs = Date.now();
		}, 1000);
		return () => clearInterval(t);
	});

	const imgSrc = $derived(selectedId ? `/api/detections/snapshot/${selectedId}?t=${imgTick}` : '');
	let isConnected = $derived(connectionState !== 'disconnected');
</script>

<svelte:head><title>Live-Detektion · IP-Cam-Master</title></svelte:head>

<div class="space-y-6 max-w-3xl">
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Live-Detektion</h1>
		<p class="mt-1 text-sm text-text-secondary">
			Live-Bild plus Protect-Detektionen samt Verbindungs- und Tap-Status.
		</p>
	</div>

	<DetectionHealthBanner {connectionState} {lastEventAt} />

	{#if cameras.length}
		<div class="space-y-2">
			<label class="flex items-center gap-2 text-sm text-text-secondary">
				<span>Kamera:</span>
				<select
					bind:value={selectedId}
					onchange={() => {
						imgFailed = false;
					}}
					class="rounded border border-border bg-bg-card px-2 py-1 text-text-primary"
				>
					{#each cameras as c (c.id)}
						<option value={c.id}>{c.name}{c.smartDetect ? '' : ' (keine KI)'}</option>
					{/each}
				</select>
			</label>

			<div class="relative overflow-hidden rounded-lg border border-border bg-black">
				{#if imgSrc && !imgFailed}
					<!-- ~1fps local snapshot; key on src so each tick reloads -->
					<img
						src={imgSrc}
						alt={'Live: ' + camName(selectedId)}
						class="w-full h-auto block"
						onerror={() => (imgFailed = true)}
						onload={() => (imgFailed = false)}
					/>
				{:else}
					<div class="flex h-64 items-center justify-center text-sm text-text-secondary">
						Kein Live-Bild verfügbar für {camName(selectedId)}.
					</div>
				{/if}

				{#if liveHit}
					<div
						class="absolute left-3 top-3 rounded bg-red-600/90 px-2 py-1 text-xs font-semibold text-white"
					>
						● {liveHit.type.toUpperCase()} erkannt · {liveHit.score}
					</div>
				{/if}
				<div
					class="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white"
				>
					{camName(selectedId)} · live
				</div>
			</div>
		</div>
	{/if}

	{#if feed.length === 0}
		<div
			class="rounded-lg border border-border bg-bg-card px-4 py-10 text-center text-sm text-text-secondary"
		>
			{#if isConnected}
				Keine Detektionen — der Tap ist verbunden und ruhig.
			{:else}
				Keine Detektionen — sobald eine Kamera-Anbindung konfiguriert ist,
				erscheinen hier die Live-Ereignisse.
			{/if}
		</div>
	{:else}
		<ul class="space-y-2">
			{#each feed as event (event.ts + ':' + event.camera + ':' + event.type + ':' + event.phase)}
				<DetectionFeedItem {event} cameraName={camName(event.camera)} />
			{/each}
		</ul>
	{/if}
</div>
