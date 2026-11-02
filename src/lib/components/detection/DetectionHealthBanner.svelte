<script lang="ts">
	// Quick-task 260610-cw6 — C5 liveness banner. Pure/presentational: it takes props,
	// holds no EventSource and does no fetching. The connected-but-quiet state is
	// rendered DISTINCTLY from disconnected/degraded (the C5 safety distinction).
	import { Wifi, WifiOff, AlertTriangle, MoonStar } from 'lucide-svelte';
	import type { ConnState } from '$lib/server/services/protect-connection-fsm';
	import { bannerState, relativeTime } from './detection-feed-view';

	let {
		connectionState,
		lastEventAt = null,
		now = Date.now()
	}: { connectionState: ConnState; lastEventAt?: number | null; now?: number } = $props();

	let view = $derived(bannerState(connectionState, lastEventAt, now));

	// Tone -> Tailwind token classes (same palette as JournalTab severityClass).
	const toneClass: Record<string, string> = {
		red: 'text-red-400 border-red-400/40 bg-red-400/10',
		yellow: 'text-yellow-400 border-yellow-400/40 bg-yellow-400/10',
		green: 'text-green-400 border-green-400/40 bg-green-400/10',
		// "quiet" — calm, not an alarm, not a fault: muted secondary text on the card bg
		muted: 'text-text-secondary border-border bg-bg-card'
	};
	let cls = $derived(toneClass[view.tone] ?? toneClass.muted);

	let relLabel = $derived(
		view.kind === 'active' && lastEventAt !== null ? relativeTime(lastEventAt, now) : null
	);
</script>

<div
	class="flex items-center gap-3 rounded-lg border px-4 py-3 {cls}"
	role="status"
	aria-live="polite"
>
	{#if view.kind === 'disconnected'}
		<WifiOff class="w-5 h-5 shrink-0" />
	{:else if view.kind === 'degraded'}
		<AlertTriangle class="w-5 h-5 shrink-0" />
	{:else if view.kind === 'quiet'}
		<MoonStar class="w-5 h-5 shrink-0" />
	{:else}
		<Wifi class="w-5 h-5 shrink-0" />
	{/if}

	<div class="flex flex-col">
		<span class="text-sm font-medium">{view.label}</span>
		{#if relLabel}
			<span class="text-xs text-text-secondary">Letzte Detektion {relLabel}</span>
		{/if}
	</div>
</div>
