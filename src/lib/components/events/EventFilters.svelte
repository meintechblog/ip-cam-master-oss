<script lang="ts">
	import type { EventSeverity, EventType } from '$lib/types';

	export interface EventFilterState {
		cameraId: number | null;
		severity: EventSeverity | null;
		eventType: EventType | null;
		since: string;
		until: string;
	}

	let {
		cameras,
		onFilter
	}: {
		cameras: { id: number; name: string }[];
		onFilter: (filters: EventFilterState) => void;
	} = $props();

	let cameraId = $state<number | null>(null);
	let severity = $state<EventSeverity | null>(null);
	let eventType = $state<EventType | null>(null);
	let since = $state('');
	let until = $state('');

	function emitFilter() {
		onFilter({ cameraId, severity, eventType, since, until });
	}

	const eventTypeLabels: { value: EventType; label: string }[] = [
		{ value: 'camera_disconnect', label: 'Getrennt' },
		{ value: 'camera_reconnect', label: 'Verbunden' },
		{ value: 'stream_failed', label: 'Stream-Fehler' },
		{ value: 'adoption_changed', label: 'Adoption' },
		{ value: 'aiport_error', label: 'AI-Port Fehler' }
	];
</script>

<div class="flex flex-wrap items-center gap-3">
	<!-- Camera filter -->
	<select
		class="bg-bg-input border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
		value={cameraId ?? ''}
		onchange={(e) => {
			const val = (e.target as HTMLSelectElement).value;
			cameraId = val ? Number(val) : null;
			emitFilter();
		}}
	>
		<option value="">Alle Kameras</option>
		{#each cameras as cam}
			<option value={cam.id}>{cam.name}</option>
		{/each}
	</select>

	<!-- Severity filter -->
	<select
		class="bg-bg-input border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
		value={severity ?? ''}
		onchange={(e) => {
			const val = (e.target as HTMLSelectElement).value;
			severity = val ? (val as EventSeverity) : null;
			emitFilter();
		}}
	>
		<option value="">Alle Schweregrade</option>
		<option value="info">Info</option>
		<option value="warning">Warnung</option>
		<option value="error">Fehler</option>
	</select>

	<!-- Event type filter -->
	<select
		class="bg-bg-input border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
		value={eventType ?? ''}
		onchange={(e) => {
			const val = (e.target as HTMLSelectElement).value;
			eventType = val ? (val as EventType) : null;
			emitFilter();
		}}
	>
		<option value="">Alle Typen</option>
		{#each eventTypeLabels as et}
			<option value={et.value}>{et.label}</option>
		{/each}
	</select>

	<!-- Date range -->
	<div class="flex items-center gap-2">
		<label class="text-xs text-text-secondary">Von</label>
		<input
			type="date"
			class="bg-bg-input border border-border rounded-lg px-2 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
			bind:value={since}
			onchange={emitFilter}
		/>
	</div>
	<div class="flex items-center gap-2">
		<label class="text-xs text-text-secondary">Bis</label>
		<input
			type="date"
			class="bg-bg-input border border-border rounded-lg px-2 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
			bind:value={until}
			onchange={emitFilter}
		/>
	</div>
</div>
