<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import { Loader2, CheckCircle } from 'lucide-svelte';

	let {
		loading = false,
		error = null,
		connectionResult = null,
		ip = '',
		username = '',
		password = '',
		onRetry,
		onNext
	}: {
		loading: boolean;
		error: string | null;
		connectionResult: { resolution?: string; fps?: number; streamPath?: string } | null;
		ip: string;
		username: string;
		password: string;
		onRetry: () => void;
		onNext: () => void;
	} = $props();

	let snapshotUrl = $state<string | null>(null);
	let snapshotLoading = $state(false);

	async function loadSnapshot() {
		if (!ip || !username || !password) return;
		snapshotLoading = true;
		try {
			const res = await fetch('/api/onboarding/snapshot', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ip, username, password })
			});
			if (res.ok) {
				const blob = await res.blob();
				snapshotUrl = URL.createObjectURL(blob);
			}
		} catch {
			// Snapshot is optional — don't block the flow
		} finally {
			snapshotLoading = false;
		}
	}

	$effect(() => {
		if (connectionResult && !error) {
			loadSnapshot();
		}
	});
</script>

<div class="space-y-6">
	{#if loading}
		<div class="flex items-center gap-3 text-text-secondary">
			<Loader2 class="w-5 h-5 animate-spin" />
			<span>Verbindung wird getestet...</span>
		</div>
	{:else if connectionResult && !error}
		<div class="flex items-center gap-3 text-success">
			<CheckCircle class="w-5 h-5" />
			<span class="font-medium">Verbindung erfolgreich</span>
		</div>

		{#if snapshotLoading}
			<div class="bg-bg-input rounded-lg h-48 flex items-center justify-center">
				<Loader2 class="w-6 h-6 animate-spin text-text-secondary" />
			</div>
		{:else if snapshotUrl}
			<div class="rounded-lg overflow-hidden border border-border">
				<img src={snapshotUrl} alt="Kamera-Vorschau" class="w-full h-auto" />
			</div>
		{/if}

		{#if connectionResult.resolution || connectionResult.fps}
			<div class="bg-bg-card border border-border rounded-lg p-4">
				<p class="text-sm text-text-secondary">
					Erkannte Parameter: {connectionResult.resolution || 'unbekannt'} @ {connectionResult.fps || '?'}fps
				</p>
				{#if connectionResult.streamPath}
					<p class="text-sm text-text-secondary mt-1">Stream-Pfad: {connectionResult.streamPath}</p>
				{/if}
			</div>
		{/if}
	{/if}

	{#if error}
		<InlineAlert type="error" message={error} />
		<button
			onclick={onRetry}
			class="bg-accent text-white rounded-lg px-4 py-2 hover:bg-accent/90 transition-colors"
		>
			Erneut versuchen
		</button>
	{/if}

	{#if connectionResult && !loading}
		<div class="flex justify-end">
			<button
				onclick={onNext}
				disabled={loading || !!error}
				class="bg-accent text-white rounded-lg px-6 py-2 hover:bg-accent/90 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
			>
				Weiter
			</button>
		</div>
	{/if}
</div>
