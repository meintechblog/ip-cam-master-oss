<script lang="ts">
	import type { CameraEvent, EventType } from '$lib/types';

	let {
		events,
		total,
		limit,
		offset,
		onPageChange
	}: {
		events: CameraEvent[];
		total: number;
		limit: number;
		offset: number;
		onPageChange: (newOffset: number) => void;
	} = $props();

	const eventTypeLabels: Record<EventType, string> = {
		camera_disconnect: 'Getrennt',
		camera_reconnect: 'Verbunden',
		stream_failed: 'Stream-Fehler',
		adoption_changed: 'Adoption',
		aiport_error: 'AI-Port'
	};

	const severityColors: Record<string, string> = {
		info: 'bg-green-400',
		warning: 'bg-yellow-400',
		error: 'bg-red-400'
	};

	function formatTimestamp(ts: string): string {
		return new Date(ts).toLocaleString('de-DE', {
			day: '2-digit',
			month: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	function truncate(str: string, max: number): string {
		if (str.length <= max) return str;
		return str.slice(0, max) + '...';
	}

	let currentPage = $derived(Math.floor(offset / limit) + 1);
	let totalPages = $derived(Math.max(1, Math.ceil(total / limit)));
</script>

<div class="bg-bg-card rounded-xl border border-border overflow-hidden">
	<div class="overflow-x-auto">
		<table class="w-full text-sm">
			<thead>
				<tr class="text-text-secondary text-xs uppercase tracking-wider border-b border-border">
					<th class="text-left px-5 py-3 font-medium">Zeitpunkt</th>
					<th class="text-left px-5 py-3 font-medium">Schwere</th>
					<th class="text-left px-5 py-3 font-medium">Kamera</th>
					<th class="text-left px-5 py-3 font-medium">Typ</th>
					<th class="text-left px-5 py-3 font-medium">Nachricht</th>
				</tr>
			</thead>
			<tbody>
				{#if events.length === 0}
					<tr>
						<td colspan="5" class="px-5 py-8 text-center text-text-secondary text-sm">
							Keine Ereignisse gefunden
						</td>
					</tr>
				{:else}
					{#each events as event (event.id)}
						<tr class="border-b border-border/50 hover:bg-bg-input/30 transition-colors">
							<td class="px-5 py-3 text-text-secondary text-xs font-mono whitespace-nowrap">
								{formatTimestamp(event.timestamp)}
							</td>
							<td class="px-5 py-3">
								<span
									class="inline-block w-2.5 h-2.5 rounded-full {severityColors[event.severity] || 'bg-gray-400'}"
									title={event.severity}
								></span>
							</td>
							<td class="px-5 py-3 text-text-primary text-xs">
								{event.cameraName || 'System'}
							</td>
							<td class="px-5 py-3">
								<span class="text-xs px-2 py-0.5 rounded-full bg-bg-input text-text-secondary">
									{eventTypeLabels[event.eventType] || event.eventType}
								</span>
							</td>
							<td class="px-5 py-3 text-text-secondary text-xs" title={event.message}>
								{truncate(event.message, 80)}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	<!-- Pagination -->
	{#if total > 0}
		<div class="flex items-center justify-between px-5 py-3 border-t border-border">
			<span class="text-xs text-text-secondary">
				Seite {currentPage} von {totalPages} ({total} Ereignisse)
			</span>
			<div class="flex items-center gap-2">
				<button
					onclick={() => onPageChange(Math.max(0, offset - limit))}
					disabled={offset === 0}
					class="px-3 py-1 text-xs rounded-lg bg-bg-input text-text-secondary hover:bg-bg-primary disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
				>
					Zurück
				</button>
				<button
					onclick={() => onPageChange(offset + limit)}
					disabled={offset + limit >= total}
					class="px-3 py-1 text-xs rounded-lg bg-bg-input text-text-secondary hover:bg-bg-primary disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
				>
					Weiter
				</button>
			</div>
		</div>
	{/if}
</div>
