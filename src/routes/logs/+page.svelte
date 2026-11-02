<script lang="ts">
	import type { CameraEvent } from '$lib/types';
	import type { EventFilterState } from '$lib/components/events/EventFilters.svelte';
	import EventFilters from '$lib/components/events/EventFilters.svelte';
	import EventTable from '$lib/components/events/EventTable.svelte';
	import JournalTab from '$lib/components/logs/JournalTab.svelte';
	import { Loader2, Trash2 } from 'lucide-svelte';

	let activeTab = $state<'events' | 'protect' | 'journal'>('events');
	let deleting = $state(false);

	// Events tab state
	let events = $state<CameraEvent[]>([]);
	let totalEvents = $state(0);
	let cameras = $state<{ id: number; name: string }[]>([]);
	let filters = $state<EventFilterState>({
		cameraId: null,
		severity: null,
		eventType: null,
		since: '',
		until: ''
	});
	let limit = $state(50);
	let offset = $state(0);
	let loading = $state(false);

	// Protect Logs tab state
	let rawLogs = $state('');
	let logLines = $state(100);
	let logsLoading = $state(false);

	async function fetchEvents() {
		loading = true;
		try {
			const params = new URLSearchParams();
			params.set('limit', String(limit));
			params.set('offset', String(offset));
			if (filters.cameraId != null) params.set('cameraId', String(filters.cameraId));
			if (filters.severity) params.set('severity', filters.severity);
			if (filters.eventType) params.set('eventType', filters.eventType);
			if (filters.since) params.set('since', new Date(filters.since).toISOString());
			if (filters.until) params.set('until', new Date(filters.until + 'T23:59:59').toISOString());

			const res = await fetch('/api/protect/events?' + params.toString());
			if (res.ok) {
				const data = await res.json();
				events = data.events ?? [];
				totalEvents = data.total ?? 0;
			}
		} catch {
			// retry next time
		} finally {
			loading = false;
		}
	}

	async function fetchCameras() {
		try {
			const res = await fetch('/api/cameras/status');
			if (res.ok) {
				const data = await res.json();
				cameras = data.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }));
			}
		} catch {
			// ignore
		}
	}

	async function fetchProtectLogs() {
		logsLoading = true;
		try {
			const res = await fetch('/api/logs/protect?lines=' + logLines);
			if (res.ok) {
				const data = await res.json();
				rawLogs = data.logs ?? '';
			}
		} catch {
			rawLogs = 'Fehler beim Laden der Logs.';
		} finally {
			logsLoading = false;
		}
	}

	function handleFilter(newFilters: EventFilterState) {
		filters = newFilters;
		offset = 0;
		fetchEvents();
	}

	function handlePageChange(newOffset: number) {
		offset = newOffset;
		fetchEvents();
	}

	async function deleteAllEvents() {
		if (!confirm('Alle Events löschen?')) return;
		deleting = true;
		try {
			await fetch('/api/protect/events', { method: 'DELETE' });
			await fetchEvents();
		} catch {
			// ignore
		} finally {
			deleting = false;
		}
	}

	// Auto-refresh events every 10s
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		fetchCameras();
		fetchEvents();
		refreshTimer = setInterval(() => {
			if (activeTab === 'events') fetchEvents();
		}, 10_000);
		return () => {
			if (refreshTimer) clearInterval(refreshTimer);
		};
	});
</script>

<div class="space-y-6">
	<!-- Header -->
	<h1 class="text-2xl font-bold text-text-primary">Logs</h1>

	<!-- Tabs -->
	<div class="flex items-center gap-1 border-b border-border">
		<button
			onclick={() => activeTab = 'events'}
			class="px-4 py-2 text-sm font-medium transition-colors cursor-pointer
				{activeTab === 'events'
				? 'text-accent border-b-2 border-accent -mb-px'
				: 'text-text-secondary hover:text-text-primary'}"
		>
			Ereignisse
		</button>
		<button
			onclick={() => activeTab = 'protect'}
			class="px-4 py-2 text-sm font-medium transition-colors cursor-pointer
				{activeTab === 'protect'
				? 'text-accent border-b-2 border-accent -mb-px'
				: 'text-text-secondary hover:text-text-primary'}"
		>
			Protect Logs
		</button>
		<button
			onclick={() => activeTab = 'journal'}
			class="px-4 py-2 text-sm font-medium transition-colors cursor-pointer
				{activeTab === 'journal'
				? 'text-accent border-b-2 border-accent -mb-px'
				: 'text-text-secondary hover:text-text-primary'}"
		>
			Systemd Journal
		</button>
	</div>

	<!-- Events Tab -->
	{#if activeTab === 'events'}
		<div class="space-y-4">
			<div class="flex items-center justify-between">
				<EventFilters {cameras} onFilter={handleFilter} />
				<button
					onclick={deleteAllEvents}
					disabled={deleting}
					class="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 border border-red-400/30 rounded-lg hover:bg-red-400/10 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
				>
					<Trash2 class="w-4 h-4" />
					{deleting ? 'Löschen...' : 'Löschen'}
				</button>
			</div>

			{#if loading}
				<div class="flex items-center gap-3 text-text-secondary py-12 justify-center">
					<Loader2 class="w-5 h-5 animate-spin" />
					<span>Ereignisse werden geladen...</span>
				</div>
			{:else}
				<EventTable
					{events}
					total={totalEvents}
					{limit}
					{offset}
					onPageChange={handlePageChange}
				/>
			{/if}
		</div>
	{/if}

	<!-- Protect Logs Tab -->
	{#if activeTab === 'protect'}
		<div class="space-y-4">
			<p class="text-xs text-text-secondary">
				Direkte SSH-Verbindung zum UDM -- zeigt /srv/unifi-protect/logs/cameras.thirdParty.log
			</p>

			<div class="flex items-center gap-3">
				<select
					class="bg-bg-input border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
					bind:value={logLines}
				>
					<option value={50}>50 Zeilen</option>
					<option value={100}>100 Zeilen</option>
					<option value={200}>200 Zeilen</option>
					<option value={500}>500 Zeilen</option>
				</select>

				<button
					onclick={fetchProtectLogs}
					disabled={logsLoading}
					class="flex items-center gap-2 px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
				>
					{#if logsLoading}
						<Loader2 class="w-4 h-4 animate-spin" />
						Laden...
					{:else}
						Logs laden
					{/if}
				</button>
			</div>

			{#if rawLogs}
				<pre class="font-mono text-xs text-text-secondary bg-bg-input rounded-lg p-4 overflow-x-auto max-h-[600px] overflow-y-auto whitespace-pre-wrap">{rawLogs}</pre>
			{:else if !logsLoading}
				<div class="bg-bg-card rounded-xl border border-border p-8 text-center text-text-secondary text-sm">
					Klicke "Logs laden" um die aktuellen Protect-Logs anzuzeigen.
				</div>
			{/if}
		</div>
	{/if}

	<!-- Systemd Journal Tab -->
	{#if activeTab === 'journal'}
		<JournalTab />
	{/if}
</div>
