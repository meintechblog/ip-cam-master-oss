<script lang="ts">
	// Quick-task 260531-2zx — Debug-Platform Tier-1 #4 (cross-cam health ampel).
	//
	// A dezent horizontal strip of one colored status dot per managed camera.
	// Click a dot → that cam's debug panel (/kameras/{id}/debug). Data comes from
	// GET /api/cameras/health-summary, fetched in the homepage's existing 10s poll
	// (no separate timer here — this component is pure presentation).
	//
	// The dot colors EXACTLY mirror the per-cam debug panel
	// (src/routes/kameras/[id]/debug/+page.svelte) so the meaning of a color is
	// identical everywhere: healthy=green, phantom/producer_dead/unreachable=red,
	// unknown (no stream_health snapshot)=gray.
	//
	// CamHealthSummary is imported from $lib/types — the same type the endpoint
	// returns — so the contract stays in one place.
	import { Activity } from 'lucide-svelte';
	import type { CamHealthSummary, CamHealthStatus } from '$lib/types';

	let { items }: { items: CamHealthSummary[] } = $props();

	// Explicit status → dot color helper (no hidden mapping). Matches the debug
	// panel's dotClass record exactly:
	//   healthy                                   → bg-emerald-500 (green)
	//   phantom | producer_dead | unreachable     → bg-red-500     (red)
	//   unknown (default / no snapshot)            → bg-white/25    (gray)
	function dotClass(status: CamHealthStatus): string {
		if (status === 'healthy') return 'bg-emerald-500';
		if (status === 'phantom' || status === 'producer_dead' || status === 'unreachable')
			return 'bg-red-500';
		return 'bg-white/25';
	}
</script>

{#if items.length}
	<div class="bg-bg-card rounded-xl p-4 border border-border">
		<div
			class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-3 uppercase tracking-wider"
		>
			<Activity class="w-3.5 h-3.5" />
			Kamera-Health
		</div>
		<div class="flex flex-wrap items-center gap-3">
			{#each items as item (item.cameraId)}
				<a
					href="/kameras/{item.cameraId}/debug"
					title="{item.name} — {item.status}"
					class="inline-flex items-center transition-opacity hover:opacity-70"
					aria-label="{item.name}: {item.status}"
				>
					<span class="inline-block w-3 h-3 rounded-full {dotClass(item.status)}"></span>
				</a>
			{/each}
		</div>
	</div>
{/if}
