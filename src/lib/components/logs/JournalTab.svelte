<script lang="ts">
	import { Loader2 } from 'lucide-svelte';

	type Severity = 'error' | 'warning' | 'info' | 'all';
	type Entry = {
		timestamp: number;
		priority: number;
		message: string;
		pid: number | null;
	};

	let severity = $state<Severity>('all');
	let lines = $state<number>(200);
	let liveTail = $state<boolean>(true);
	let entries = $state<Entry[]>([]);
	let loading = $state<boolean>(false);
	let error = $state<string | null>(null);
	let source: EventSource | null = null;
	let listEl: HTMLDivElement | null = null;
	let isPinnedToBottom = $state<boolean>(true);

	function normalizeMessage(msg: unknown): string {
		if (typeof msg === 'string') return msg;
		if (Array.isArray(msg)) {
			try {
				return new TextDecoder('utf-8').decode(new Uint8Array(msg as number[]));
			} catch {
				return String(msg);
			}
		}
		return String(msg ?? '');
	}

	function parseRawEntry(raw: Record<string, unknown>): Entry {
		const tsMicros = Number(raw.__REALTIME_TIMESTAMP ?? 0);
		return {
			timestamp: Math.floor(tsMicros / 1000),
			priority: Number(raw.PRIORITY ?? 6),
			message: normalizeMessage(raw.MESSAGE),
			pid: raw._PID ? Number(raw._PID) : null
		};
	}

	async function fetchSnapshot() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/logs/journal?lines=${lines}&severity=${severity}`);
			if (!res.ok) {
				error = `Fehler beim Laden (HTTP ${res.status})`;
				return;
			}
			const data = (await res.json()) as { entries: Entry[]; error?: string };
			if (data.error) {
				error = data.error;
				entries = [];
				return;
			}
			entries = data.entries ?? [];
			queueMicrotask(scrollToBottomIfPinned);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Fehler beim Laden';
		} finally {
			loading = false;
		}
	}

	function openStream() {
		closeStream();
		if (!liveTail) return;
		source = new EventSource(`/api/logs/journal/stream?severity=${severity}`);
		source.addEventListener('entry', (e: MessageEvent) => {
			try {
				const raw = JSON.parse(e.data);
				const entry = parseRawEntry(raw);
				entries = [...entries.slice(-999), entry];
				queueMicrotask(scrollToBottomIfPinned);
			} catch {
				/* skip malformed line */
			}
		});
		source.onerror = () => {
			/* EventSource handles reconnect automatically */
		};
	}

	function closeStream() {
		if (source) {
			source.close();
			source = null;
		}
	}

	function scrollToBottomIfPinned() {
		if (!listEl || !isPinnedToBottom) return;
		listEl.scrollTop = listEl.scrollHeight;
	}

	function handleScroll() {
		if (!listEl) return;
		// Pin to bottom when user is within 50px of the end — otherwise respect their position
		const distanceFromBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
		isPinnedToBottom = distanceFromBottom < 50;
	}

	function formatTime(ms: number): string {
		try {
			return new Date(ms).toLocaleTimeString('de-DE', {
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit'
			});
		} catch {
			return '';
		}
	}

	function severityClass(priority: number): string {
		if (priority <= 3) return 'text-red-400 border-red-400/40 bg-red-400/10';
		if (priority === 4) return 'text-yellow-400 border-yellow-400/40 bg-yellow-400/10';
		return 'text-text-secondary border-border bg-bg-card';
	}

	function severityLabel(priority: number): string {
		if (priority <= 3) return 'ERR';
		if (priority === 4) return 'WARN';
		if (priority <= 6) return 'INFO';
		return 'DBG';
	}

	$effect(() => {
		severity;
		lines;
		liveTail;
		fetchSnapshot().then(() => openStream());
		return () => {
			closeStream();
		};
	});
</script>

<div class="space-y-4">
	<p class="text-xs text-text-secondary">
		Systemd-Journal der ip-cam-master Unit (journalctl -u ip-cam-master)
	</p>

	<div class="flex flex-wrap items-center gap-3">
		<label class="flex items-center gap-2 text-xs text-text-secondary">
			Schweregrad
			<select
				class="bg-bg-input border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
				bind:value={severity}
			>
				<option value="all">Alle</option>
				<option value="info">Info</option>
				<option value="warning">Warnung</option>
				<option value="error">Fehler</option>
			</select>
		</label>

		<label class="flex items-center gap-2 text-xs text-text-secondary">
			Zeilen
			<select
				class="bg-bg-input border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
				bind:value={lines}
			>
				<option value={50}>50</option>
				<option value={100}>100</option>
				<option value={200}>200</option>
				<option value={500}>500</option>
				<option value={1000}>1000</option>
			</select>
		</label>

		<button
			type="button"
			onclick={() => (liveTail = !liveTail)}
			class="px-3 py-1.5 text-sm rounded-lg border transition-colors cursor-pointer
				{liveTail
				? 'bg-accent/20 border-accent text-accent'
				: 'bg-bg-input border-border text-text-secondary hover:text-text-primary'}"
		>
			Live
		</button>

		<button
			type="button"
			onclick={fetchSnapshot}
			disabled={loading}
			class="flex items-center gap-2 px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
		>
			{#if loading}
				<Loader2 class="w-4 h-4 animate-spin" />
				Laden...
			{:else}
				Neu laden
			{/if}
		</button>
	</div>

	{#if error}
		<div
			class="text-sm text-red-400 border border-red-400/30 bg-red-400/10 rounded-lg px-3 py-2"
		>
			Fehler beim Laden: {error}
		</div>
	{/if}

	<div
		bind:this={listEl}
		onscroll={handleScroll}
		class="max-h-[600px] overflow-y-auto bg-bg-input rounded-lg p-4 font-mono text-xs"
	>
		{#if entries.length === 0 && !loading}
			<div class="text-center text-text-secondary py-8">Keine Einträge</div>
		{:else}
			<ul class="space-y-1">
				{#each entries as entry (entry.timestamp + ':' + entry.message)}
					<li class="flex items-start gap-2 whitespace-pre-wrap">
						<span class="text-text-secondary shrink-0">{formatTime(entry.timestamp)}</span>
						<span
							class="shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase {severityClass(
								entry.priority
							)}"
						>
							{severityLabel(entry.priority)}
						</span>
						<span class="text-text-primary break-all">{entry.message}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
