<script lang="ts">
	import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-svelte';

	type VersionResponse = {
		sha: string;
		shaShort: string;
		dbHealthy: boolean;
		updateStatus?: string;
	};

	type Props = {
		expectedSha?: string | null;
		startSha: string;
		onComplete: (newSha: string) => void;
	};

	const { expectedSha = null, startSha, onComplete }: Props = $props();

	let elapsed = $state(0);
	let attempts = $state(0);
	let timedOut = $state(false);
	let success = $state(false);
	let lastSha = $state<string | null>(null);

	const TIMEOUT_SEC = 90;
	const POLL_INTERVAL_MS = 2000;
	let pollHandle: ReturnType<typeof setInterval> | null = null;
	let tickHandle: ReturnType<typeof setInterval> | null = null;

	function start(): void {
		stop();
		pollHandle = setInterval(poll, POLL_INTERVAL_MS);
		tickHandle = setInterval(() => {
			elapsed += 1;
			if (elapsed >= TIMEOUT_SEC) {
				timedOut = true;
				stop();
			}
		}, 1000);
	}

	function stop(): void {
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
		if (tickHandle) {
			clearInterval(tickHandle);
			tickHandle = null;
		}
	}

	async function poll(): Promise<void> {
		attempts += 1;
		try {
			const res = await fetch('/api/version', { cache: 'no-store' });
			if (!res.ok) return;
			const body = (await res.json()) as VersionResponse;
			lastSha = body.shaShort;
			const expectedMatch = expectedSha ? body.sha === expectedSha : body.sha !== startSha;
			if (expectedMatch && body.dbHealthy) {
				success = true;
				stop();
				onComplete(body.sha);
			}
		} catch {
			/* network blip — keep polling until timeout */
		}
	}

	function retry(): void {
		elapsed = 0;
		attempts = 0;
		timedOut = false;
		success = false;
		start();
	}

	$effect(() => {
		start();
		return stop;
	});
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
	<div class="bg-bg-card border border-border rounded-lg p-8 max-w-md w-full mx-4 space-y-4">
		{#if success}
			<div class="flex items-center gap-3 text-green-400">
				<CheckCircle2 class="w-6 h-6" />
				<h2 class="text-lg font-semibold">Update abgeschlossen</h2>
			</div>
			<p class="text-sm text-text-secondary">
				Neue Version <span class="font-mono">{lastSha}</span> ist aktiv.
			</p>
		{:else if timedOut}
			<div class="flex items-center gap-3 text-orange-400">
				<AlertCircle class="w-6 h-6" />
				<h2 class="text-lg font-semibold">Verbindung dauert ungewöhnlich lang</h2>
			</div>
			<p class="text-sm text-text-secondary">
				Nach {TIMEOUT_SEC}s konnte der Server noch nicht erreicht werden. Das Update läuft
				möglicherweise noch — du kannst manuell erneut prüfen oder den Server-Log via SSH
				ansehen.
			</p>
			<button
				type="button"
				onclick={retry}
				class="px-4 py-2 bg-accent text-white rounded font-medium hover:bg-accent/90 transition-colors"
			>
				Erneut versuchen
			</button>
		{:else}
			<div class="flex items-center gap-3 text-blue-400">
				<Loader2 class="w-6 h-6 animate-spin" />
				<h2 class="text-lg font-semibold">Update wird abgeschlossen…</h2>
			</div>
			<p class="text-sm text-text-secondary">
				Der Server startet neu. Sobald die neue Version antwortet, geht's weiter.
			</p>
			<div class="text-xs text-text-secondary space-y-1">
				<div>Verstrichen: {elapsed}s / {TIMEOUT_SEC}s</div>
				<div>Versuch: {attempts}</div>
				{#if lastSha}
					<div>Aktuell sichtbar: <span class="font-mono">{lastSha}</span></div>
				{/if}
			</div>
		{/if}
	</div>
</div>
