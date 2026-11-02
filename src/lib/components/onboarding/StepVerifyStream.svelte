<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import { Loader2, CheckCircle, Copy, Check } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { copyToClipboard } from '$lib/utils/clipboard';

	let {
		loading = false,
		error = null,
		containerIp = null,
		streamName = '',
		rtspUrl = null,
		streamInfo = null,
		onRetry,
		onComplete
	}: {
		loading: boolean;
		error: string | null;
		containerIp: string | null;
		streamName: string;
		rtspUrl: string | null;
		streamInfo: { active: boolean; codec: string | null; producers: number } | null;
		onRetry: () => void;
		onComplete: () => void;
	} = $props();

	let copied = $state(false);

	async function copyRtspUrl() {
		if (!rtspUrl) return;
		if (await copyToClipboard(rtspUrl)) {
			copied = true;
			setTimeout(() => { copied = false; }, 2000);
		}
	}
</script>

<div class="space-y-6">
	{#if loading}
		<div class="flex items-center gap-3 text-text-secondary">
			<Loader2 class="w-5 h-5 animate-spin" />
			<span>Stream wird verifiziert...</span>
		</div>
	{:else if rtspUrl && streamInfo && !error}
		<div class="flex items-center gap-3 text-success">
			<CheckCircle class="w-5 h-5" />
			<span class="font-medium">Stream aktiv</span>
		</div>

		<!-- WebRTC Live Preview -->
		{#if containerIp}
			<div class="border border-border rounded-lg overflow-hidden">
				<iframe
					src="http://{containerIp}:1984/stream.html?src={streamName}"
					width="640"
					height="360"
					title="Live Preview"
					class="w-full max-w-[640px] aspect-video bg-black"
					allow="autoplay"
				></iframe>
			</div>
		{/if}

		<!-- Stream Info -->
		<div class="bg-bg-card border border-border rounded-lg p-4 space-y-3">
			<div class="flex items-center gap-2">
				<span class="text-sm text-text-secondary">RTSP URL:</span>
				<code class="text-sm text-text-primary font-mono bg-bg-input px-2 py-1 rounded">
					rtsp://{containerIp}:8554/{streamName}
				</code>
				<button
					onclick={copyRtspUrl}
					class="p-1 text-text-secondary hover:text-text-primary transition-colors"
					title="In Zwischenablage kopieren"
				>
					{#if copied}
						<Check class="w-4 h-4 text-success" />
					{:else}
						<Copy class="w-4 h-4" />
					{/if}
				</button>
			</div>
			{#if streamInfo.codec}
				<p class="text-sm text-text-secondary">Codec: <span class="text-text-primary">{streamInfo.codec}</span></p>
			{/if}
			<p class="text-sm text-text-secondary">Status: <span class="text-success font-medium">Aktiv</span></p>
		</div>

		<p class="text-sm text-text-secondary">
			Diese URL kann in UniFi Protect als RTSP-Kamera hinzugefuegt werden.
		</p>
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

	{#if rtspUrl && !loading && !error}
		<div class="flex justify-end">
			<button
				onclick={onComplete}
				class="bg-success text-white rounded-lg px-6 py-2 hover:bg-success/90 transition-colors font-medium"
			>
				Fertig
			</button>
		</div>
	{/if}
</div>
