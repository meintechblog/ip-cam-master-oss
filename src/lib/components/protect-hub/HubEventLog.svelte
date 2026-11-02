<script lang="ts">
	// v1.3 Phase 22 Plan 05 — Hub event log (HUB-UI-08, "Letzte Ereignisse").
	//
	// Polls GET /api/protect-hub/events?limit=50 every 10 s. Renders a
	// divide-y mono grid (UI-SPEC §event-log lines 404-408): time · type
	// badge · status · short reconcile id. Empty-state when no events yet.
	// Error rows tinted text-danger per UI-SPEC line 296.
	//
	// Click-through to a detail view is a P23 polish item (deferred per
	// CONTEXT.md "Drift-indicator click-through... is a P23 candidate").
	type EventRow = {
		id: number;
		createdAt?: string;
		timestamp?: string;
		eventType: string;
		severity: string;
		message?: string;
		metadata?: string;
	};

	let events = $state<EventRow[]>([]);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function refresh() {
		try {
			const res = await fetch('/api/protect-hub/events?limit=50');
			const body = await res.json();
			if (body.ok && Array.isArray(body.events)) {
				events = body.events as EventRow[];
			}
		} catch {
			// network blip — keep last good state
		}
	}

	$effect(() => {
		refresh();
		pollTimer = setInterval(refresh, 10000);
		return () => {
			if (pollTimer) clearInterval(pollTimer);
		};
	});

	function formatTime(iso: string | undefined): string {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleTimeString('de-DE', { hour12: false });
		} catch {
			return '—';
		}
	}

	function reconcileIdShort(metadata: string | undefined): string {
		if (!metadata) return '—';
		try {
			const m = JSON.parse(metadata) as { reconcileId?: string };
			const id = m.reconcileId ?? '';
			return id.slice(0, 8) || '—';
		} catch {
			return '—';
		}
	}

	function rowTimestamp(ev: EventRow): string {
		return formatTime(ev.timestamp ?? ev.createdAt);
	}
</script>

<div class="bg-bg-card border border-border rounded-lg p-6 mt-6">
	<h2 class="text-base font-semibold text-text-primary mb-4">Letzte Ereignisse</h2>

	{#if events.length === 0}
		<p class="text-sm text-text-secondary">Noch keine Ereignisse aufgezeichnet.</p>
	{:else}
		<div class="divide-y divide-border">
			{#each events as ev (ev.id)}
				<div
					class="py-2 grid grid-cols-[auto_auto_auto_1fr] gap-3 items-center text-xs font-mono"
				>
					<span class="text-text-secondary">{rowTimestamp(ev)}</span>
					<span
						class="bg-bg-input px-2 py-1 rounded text-xs font-mono {ev.severity === 'error'
							? 'text-danger'
							: 'text-text-secondary'}"
					>
						{ev.eventType}
					</span>
					<span class={ev.severity === 'error' ? 'text-danger' : 'text-success'}>
						{ev.severity === 'error' ? 'failed' : 'success'}
					</span>
					<span class="text-text-secondary truncate">{reconcileIdShort(ev.metadata)}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
