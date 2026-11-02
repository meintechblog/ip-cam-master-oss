<script lang="ts">
	// Quick-task 260611-lhm — Bird-Eye Live-Karte (M2 Slice 2). Polls
	// /api/detections/birdeye every 3s and renders the mapped foot points of the
	// last detections on the aerial photo. Poll instead of SSE is deliberate
	// (R41 negative: single-viewer LAN tool → R12 lean; SSE is a Slice-3 option).
	// Local-first: positions are fetched from the LAN-bound endpoint only.

	type Position = {
		camera: string;
		cameraName: string;
		type: string;
		score?: number;
		ts: number;
		x: number;
		y: number;
	};
	type BirdeyeResponse = {
		ok: boolean;
		reason?: string;
		mapImage?: string;
		mapSize?: { width: number; height: number };
		positions?: Position[];
		calibrated?: string[];
	};

	const MINUTES = 10;
	const WINDOW_MS = MINUTES * 60_000;
	const FRESH_MS = 60_000;
	// Healthy cadence 3s; on error/disconnect back off to 15s — together with
	// the server-side circuit breaker this protects the shared Protect client.
	const POLL_OK_MS = 3000;
	const POLL_BACKOFF_MS = 15_000;

	let positions = $state<Position[]>([]);
	let calibrated = $state<string[]>([]);
	let mapImage = $state('/birdeye/luftbild.jpg');
	let mapSize = $state({ width: 1101, height: 823 });
	let disconnected = $state(false);
	let nowMs = $state(Date.now());

	let pollMs = POLL_OK_MS;
	let inFlight = false;

	async function poll() {
		if (inFlight) return; // no overlapping requests on slow responses
		inFlight = true;
		try {
			const res = await fetch(`/api/detections/birdeye?minutes=${MINUTES}`);
			if (!res.ok) {
				pollMs = POLL_BACKOFF_MS;
				return;
			}
			const data = (await res.json()) as BirdeyeResponse;
			disconnected = data.reason === 'disconnected';
			pollMs = !data.ok || data.reason === 'disconnected' ? POLL_BACKOFF_MS : POLL_OK_MS;
			if (data.mapImage) mapImage = data.mapImage;
			if (data.mapSize) mapSize = data.mapSize;
			positions = data.positions ?? [];
			if (data.calibrated) calibrated = data.calibrated;
		} catch {
			/* keep last state — next tick retries */
			pollMs = POLL_BACKOFF_MS;
		} finally {
			inFlight = false;
		}
	}

	$effect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		// setTimeout chain instead of setInterval: the delay adapts to pollMs
		// (3s healthy / 15s backoff) and never stacks overlapping requests.
		async function loop() {
			if (stopped) return;
			if (!document.hidden) await poll(); // pause polling in background tabs
			if (stopped) return;
			timer = setTimeout(loop, pollMs);
		}
		loop();
		// Dot aging keeps ticking at a fixed cadence, independent of the poll.
		const tick = setInterval(() => (nowMs = Date.now()), 3000);
		return () => {
			stopped = true;
			clearTimeout(timer);
			clearInterval(tick);
		};
	});

	// Client-side aging between polls: points older than the window vanish.
	const visible = $derived(positions.filter((p) => nowMs - p.ts < WINDOW_MS));

	const timeFmt = new Intl.DateTimeFormat('de-DE', {
		timeZone: 'Europe/Berlin',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});

	function dotColor(type: string): string {
		if (type === 'person') return 'bg-red-500';
		if (type === 'vehicle') return 'bg-blue-500';
		return 'bg-gray-400';
	}
	// Fresh (<60s) = full strength; afterwards fade 0.8 → 0.25 across the window.
	function dotOpacity(ts: number): number {
		const age = nowMs - ts;
		if (age < FRESH_MS) return 1;
		const f = Math.min(1, (age - FRESH_MS) / (WINDOW_MS - FRESH_MS));
		return 0.8 - 0.55 * f;
	}
	function label(p: Position): string {
		return `${p.cameraName} · ${p.type} · ${timeFmt.format(new Date(p.ts))}`;
	}
</script>

<svelte:head><title>Karte · IP-Cam-Master</title></svelte:head>

<div class="space-y-6 max-w-4xl">
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Karte</h1>
		<p class="mt-1 text-sm text-text-secondary">
			Luftbild mit den Positionen der Detektionen der letzten {MINUTES} Minuten.
		</p>
	</div>

	{#if disconnected}
		<div class="rounded-lg border border-border bg-bg-card px-4 py-3 text-sm text-text-secondary">
			Nicht verbunden — sobald die Protect-Anbindung steht, erscheinen hier Live-Positionen.
		</div>
	{/if}

	<div class="relative overflow-hidden rounded-lg border border-border bg-black">
		<img
			src={mapImage}
			alt="Luftbild des Grundstücks"
			width={mapSize.width}
			height={mapSize.height}
			class="block h-auto w-full"
		/>
		{#each visible as p, i (p.camera + ':' + p.ts + ':' + p.type + ':' + i)}
			<div
				class="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white/70
					{dotColor(p.type)} {nowMs - p.ts < FRESH_MS ? 'motion-safe:animate-pulse' : ''}"
				style="left:{(p.x / mapSize.width) * 100}%; top:{(p.y / mapSize.height) *
					100}%; opacity:{dotOpacity(p.ts)}"
				title={label(p)}
			></div>
		{/each}
	</div>

	<div class="flex flex-wrap items-center gap-4 text-xs text-text-secondary">
		<span class="flex items-center gap-1.5">
			<span class="inline-block h-2.5 w-2.5 rounded-full bg-red-500"></span> Person
		</span>
		<span class="flex items-center gap-1.5">
			<span class="inline-block h-2.5 w-2.5 rounded-full bg-blue-500"></span> Fahrzeug
		</span>
		<span class="flex items-center gap-1.5">
			<span class="inline-block h-2.5 w-2.5 rounded-full bg-gray-400"></span> Sonstiges
		</span>
	</div>

	{#if visible.length === 0 && !disconnected}
		<div
			class="rounded-lg border border-border bg-bg-card px-4 py-6 text-center text-sm text-text-secondary"
		>
			Keine Detections in den letzten {MINUTES} Minuten.
			{#if calibrated.length}
				<div class="mt-1 text-xs">Kalibrierte Kameras: {calibrated.join(', ')}</div>
			{/if}
		</div>
	{/if}
</div>
