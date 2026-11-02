<script lang="ts">
	// Aktivitäts-Ansicht (Nutzerwunsch): zeigt NUR Kameras, auf denen gerade
	// etwas erkannt wird — Kachel erscheint beim ersten Event, lebt solange Events
	// nachkommen (60s TTL, 'ended' verkürzt auf 15s Grace) und verschwindet dann.
	// Fleet-UI-Leitlinie "Zustands-getriebenes Rendering": SSE-Push (kein Poll fürs
	// Einblenden), Sichtbarkeit aus echtem Detection-Zustand, stabile Kachel-Reihen-
	// folge (first-seen — kein Umsortieren/Springen während sichtbar), ehrlicher
	// Leerzustand statt leerer Kacheln. Snapshots ~1fps nur für SICHTBARE Kacheln.
	import DetectionHealthBanner from '$lib/components/detection/DetectionHealthBanner.svelte';
	import type { DetectionStatus } from '$lib/server/services/detection-service';
	import type { MinimalEvent } from '$lib/server/services/detection-tap-fsm';
	import type { ConnState } from '$lib/server/services/protect-connection-fsm';

	type CamOption = { id: string; name: string; smartDetect: boolean };
	type Activity = {
		camera: string;
		firstSeen: number; // stable ordering anchor
		lastTs: number;
		lastType: string;
		lastScore: number;
		lastPhase: string;
		activeUntil: number;
	};

	const ACTIVE_TTL_MS = 60_000;
	const ENDED_GRACE_MS = 15_000;

	// Mirrors the night-watch outdoor set — the server has no indoor/outdoor flag
	// (yet); names are matched trimmed. "Alle" shows indoor cams too.
	const OUTDOOR = new Set([
		'Auffahrt', 'Balkon', 'Bob the Builder', 'Carport', 'Haustür', 'Hausür - Entry',
		'Hochbeet', 'Intercom', 'Park', 'Parkplatz', 'Spielturm', 'Terrasse'
	]);

	let connectionState = $state<ConnState>('disconnected');
	let lastEventAt = $state<number | null>(null);
	let cameras = $state<CamOption[]>([]);
	let activities = $state<Activity[]>([]);
	let outdoorOnly = $state(true);
	let nowMs = $state(Date.now());
	let imgTick = $state(0);
	let source: EventSource | null = null;

	const nameById = $derived(new Map(cameras.map((c) => [c.id, c.name.trim()] as const)));
	function camName(id: string): string {
		return nameById.get(id) ?? id;
	}

	function bump(ev: MinimalEvent) {
		const until = ev.ts + (ev.phase === 'ended' ? ENDED_GRACE_MS : ACTIVE_TTL_MS);
		const existing = activities.find((a) => a.camera === ev.camera);
		if (existing) {
			existing.lastTs = ev.ts;
			existing.lastType = ev.type;
			existing.lastScore = ev.score;
			existing.lastPhase = ev.phase;
			// 'ended' only ever shortens; a fresh 'confirmed' extends
			existing.activeUntil = ev.phase === 'ended' ? Math.min(existing.activeUntil, until) : Math.max(existing.activeUntil, until);
		} else if (ev.phase !== 'ended') {
			activities = [...activities, {
				camera: ev.camera, firstSeen: ev.ts, lastTs: ev.ts,
				lastType: ev.type, lastScore: ev.score, lastPhase: ev.phase, activeUntil: until
			}];
		}
	}

	function applyStatus(s: DetectionStatus) {
		connectionState = s.connectionState;
		lastEventAt = s.lastEventAt;
		// Seed from the recent buffer (oldest→newest so phases apply in order).
		for (const ev of [...(s.recent ?? [])].reverse()) bump(ev);
	}

	// Visible = still active + filter. Order: first-seen (stable, no re-shuffling).
	const visible = $derived(
		activities
			.filter((a) => a.activeUntil > nowMs)
			.filter((a) => !outdoorOnly || OUTDOOR.has(camName(a.camera)))
			.sort((a, b) => a.firstSeen - b.firstSeen)
	);

	$effect(() => {
		let cancelled = false;

		(async () => {
			try {
				const res = await fetch('/api/detections/cameras');
				if (!res.ok) return;
				const data = (await res.json()) as { ok: boolean; cameras?: CamOption[] };
				if (!cancelled && data.ok && data.cameras) cameras = data.cameras;
			} catch { /* names fall back to ids */ }
		})();

		(async () => {
			try {
				const res = await fetch('/api/detections/status');
				if (!res.ok) return;
				const data = (await res.json()) as DetectionStatus;
				if (!cancelled) applyStatus(data);
			} catch { /* banner carries the disconnected state */ }
		})();

		source = new EventSource('/api/detections/live');
		source.addEventListener('status', (e: MessageEvent) => {
			try {
				const s = JSON.parse(e.data) as DetectionStatus;
				connectionState = s.connectionState;
				lastEventAt = s.lastEventAt;
			} catch { /* skip malformed frame */ }
		});
		source.addEventListener('detection', (e: MessageEvent) => {
			try {
				const ev = JSON.parse(e.data) as MinimalEvent;
				bump(ev);
				lastEventAt = ev.ts;
			} catch { /* skip malformed frame */ }
		});
		source.onerror = () => {
			connectionState = 'degraded';
		};

		return () => {
			cancelled = true;
			source?.close();
			source = null;
		};
	});

	// 1s tick: expires tiles (nowMs) + refreshes snapshots of visible tiles; prunes
	// long-dead entries so the array stays bounded.
	$effect(() => {
		const t = setInterval(() => {
			nowMs = Date.now();
			imgTick++;
			if (activities.some((a) => a.activeUntil < nowMs - 300_000)) {
				activities = activities.filter((a) => a.activeUntil >= nowMs - 300_000);
			}
		}, 1000);
		return () => clearInterval(t);
	});

	const TYPE_LABEL: Record<string, string> = {
		person: 'Person', vehicle: 'Fahrzeug', animal: 'Tier', face: 'Gesicht', package: 'Paket'
	};
	function typeLabel(t: string): string {
		return TYPE_LABEL[t] ?? t;
	}
	function ago(ts: number): string {
		const s = Math.max(0, Math.round((nowMs - ts) / 1000));
		return s < 5 ? 'jetzt' : `vor ${s}s`;
	}
	let isConnected = $derived(connectionState !== 'disconnected');
</script>

<svelte:head><title>Aktivität · IP-Cam-Master</title></svelte:head>

<div class="space-y-6">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold text-text-primary">Aktivität</h1>
			<p class="mt-1 text-sm text-text-secondary">
				Nur Kameras mit aktueller Erkennung — erscheinen live, verschwinden bei Ruhe.
			</p>
		</div>
		<div class="flex gap-1 rounded-lg border border-border bg-bg-card p-1 text-sm">
			<button
				class="rounded px-3 py-1 {outdoorOnly ? 'bg-accent text-white' : 'text-text-secondary'}"
				onclick={() => (outdoorOnly = true)}
			>Außen</button>
			<button
				class="rounded px-3 py-1 {!outdoorOnly ? 'bg-accent text-white' : 'text-text-secondary'}"
				onclick={() => (outdoorOnly = false)}
			>Alle</button>
		</div>
	</div>

	<DetectionHealthBanner {connectionState} {lastEventAt} />

	{#if visible.length === 0}
		<div class="rounded-lg border border-border bg-bg-card px-4 py-16 text-center text-sm text-text-secondary">
			{#if isConnected}
				{outdoorOnly ? 'Draußen ist gerade Ruhe' : 'Gerade keine Aktivität'} — sobald eine Kamera
				etwas erkennt, erscheint sie hier automatisch.
			{:else}
				Nicht verbunden — sobald die Kamera-Anbindung steht, erscheinen hier aktive Kameras.
			{/if}
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each visible as a (a.camera)}
				<div class="overflow-hidden rounded-lg border border-border bg-black">
					<div class="relative aspect-video">
						<img
							src={`/api/detections/snapshot/${a.camera}?t=${imgTick}`}
							alt={'Live: ' + camName(a.camera)}
							class="absolute inset-0 h-full w-full object-cover"
						/>
						{#if a.lastPhase === 'confirmed' && nowMs - a.lastTs < 5000}
							<div class="absolute left-2 top-2 animate-pulse rounded bg-red-600/90 px-2 py-1 text-xs font-semibold text-white">
								● {typeLabel(a.lastType)} · {a.lastScore}
							</div>
						{/if}
						<div class="absolute bottom-0 inset-x-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-3 py-2">
							<span class="text-sm font-medium text-white">{camName(a.camera)}</span>
							<span class="text-xs text-white/80">{typeLabel(a.lastType)} · {ago(a.lastTs)}</span>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
