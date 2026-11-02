<script lang="ts">
	// Quick-task 260610-cw6 — single MinimalEvent row. Pure/presentational.
	// Local-first: renders ONLY the five MinimalEvent fields (camera, type, phase,
	// score, ts). No image media of any kind — the API never sends it, we never fetch.
	// All event fields are rendered as auto-escaped text interpolation (never raw
	// HTML) — the `type` string maps to a known icon, never trusted/executed (T-cw6-02).
	import { User, Car, PawPrint, Package, Eye } from 'lucide-svelte';
	import type { MinimalEvent } from '$lib/server/services/detection-tap-fsm';
	import { iconNameForType, phaseLabel, relativeTime, formatTime } from './detection-feed-view';

	// `cameraName` (optional): resolved friendly name for event.camera (which is the
	// bare Protect id). Falls back to the id when no name is supplied.
	let {
		event,
		now = Date.now(),
		cameraName = undefined
	}: { event: MinimalEvent; now?: number; cameraName?: string } = $props();

	const ICONS = { User, Car, PawPrint, Package, Eye } as const;
	let Icon = $derived(ICONS[iconNameForType(event.type)]);

	let phaseCls = $derived(
		event.phase === 'confirmed'
			? 'text-green-400 border-green-400/40 bg-green-400/10'
			: 'text-text-secondary border-border bg-bg-card'
	);
</script>

<li
	class="flex items-center gap-3 rounded-lg border border-border bg-bg-card px-3 py-2"
>
	<Icon class="w-5 h-5 shrink-0 text-accent" />

	<div class="flex flex-col min-w-0 flex-1">
		<span class="text-sm font-medium text-text-primary truncate">{cameraName ?? event.camera}</span>
		<span class="text-xs text-text-secondary truncate">{event.type}</span>
	</div>

	<span
		class="shrink-0 px-2 py-0.5 rounded border text-[10px] font-semibold uppercase {phaseCls}"
	>
		{phaseLabel(event.phase)}
	</span>

	<span class="shrink-0 text-xs font-mono text-text-secondary">
		Score {Math.round(event.score)}
	</span>

	<span class="shrink-0 text-xs text-text-secondary" title={formatTime(event.ts)}>
		{relativeTime(event.ts, now)}
	</span>
</li>
