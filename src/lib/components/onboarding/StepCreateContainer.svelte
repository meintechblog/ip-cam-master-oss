<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import { Loader2, CheckCircle } from 'lucide-svelte';

	let {
		loading = false,
		error = null,
		vmid = null,
		containerIp = null,
		onRetry,
		onNext
	}: {
		loading: boolean;
		error: string | null;
		vmid: number | null;
		containerIp: string | null;
		onRetry: () => void;
		onNext: () => void;
	} = $props();
</script>

<div class="space-y-6">
	{#if loading}
		<div class="flex items-center gap-3 text-text-secondary">
			<Loader2 class="w-5 h-5 animate-spin" />
			<span>Container wird erstellt...</span>
		</div>
	{:else if containerIp && !error}
		<div class="flex items-center gap-3 text-success">
			<CheckCircle class="w-5 h-5" />
			<span class="font-medium">Container erstellt</span>
		</div>
		<div class="bg-bg-card border border-border rounded-lg p-4 space-y-1">
			<p class="text-sm text-text-secondary">VMID: <span class="text-text-primary font-mono">{vmid}</span></p>
			<p class="text-sm text-text-secondary">Container-IP: <span class="text-text-primary font-mono">{containerIp}</span></p>
		</div>
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

	{#if containerIp && !loading && !error}
		<div class="flex justify-end">
			<button
				onclick={onNext}
				class="bg-accent text-white rounded-lg px-6 py-2 hover:bg-accent/90 transition-colors font-medium"
			>
				Weiter
			</button>
		</div>
	{/if}
</div>
