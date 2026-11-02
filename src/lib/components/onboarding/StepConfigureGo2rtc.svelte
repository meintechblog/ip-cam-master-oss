<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import { Loader2, CheckCircle } from 'lucide-svelte';
	import { onMount } from 'svelte';

	let {
		loading = false,
		error = null,
		done = false,
		onRetry,
		onNext
	}: {
		loading: boolean;
		error: string | null;
		done: boolean;
		onRetry: () => void;
		onNext: () => void;
	} = $props();

	const subSteps = [
		'apt-get update + ffmpeg installieren...',
		'go2rtc Binary von GitHub herunterladen...',
		'go2rtc.yaml mit VAAPI-Transcoding generieren...',
		'go2rtc systemd Service anlegen + starten...',
		'Node.js 22 LTS im Container installieren...',
		'ONVIF Server von GitHub klonen + npm install...',
		'config.yaml mit MAC, UUID, Stream-Mapping generieren...',
		'Device-Naming in onvif-server.js patchen (Manufacturer, Model)...',
		'ONVIF Server systemd Service anlegen + starten...',
		'Warte auf Stream-Initialisierung...'
	];

	let currentSubStep = $state(0);
	let intervalId: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		if (loading) {
			intervalId = setInterval(() => {
				currentSubStep = (prev => Math.min(prev + 1, subSteps.length - 1))(currentSubStep);
			}, 2000);
		}
		return () => { if (intervalId) clearInterval(intervalId); };
	});

	$effect(() => {
		if (!loading && intervalId) {
			clearInterval(intervalId);
			intervalId = undefined;
		}
		if (loading) {
			currentSubStep = 0;
			intervalId = setInterval(() => {
				currentSubStep = Math.min(currentSubStep + 1, subSteps.length - 1);
			}, 2000);
		}
	});
</script>

<div class="space-y-6">
	{#if loading}
		<div class="flex items-center gap-3 text-text-secondary">
			<Loader2 class="w-5 h-5 animate-spin" />
			<span>go2rtc + ONVIF Server werden konfiguriert...</span>
		</div>
		<div class="bg-bg-card border border-border rounded-lg p-4">
			{#each subSteps as step, i}
				<p class="text-sm {i <= currentSubStep ? 'text-text-primary' : 'text-text-secondary/40'} {i === currentSubStep ? 'font-medium' : ''}">
					{#if i < currentSubStep}
						<span class="text-success mr-1">&#10003;</span>
					{:else if i === currentSubStep}
						<span class="mr-1">&#9679;</span>
					{:else}
						<span class="mr-1">&#9675;</span>
					{/if}
					{step}
				</p>
			{/each}
		</div>
	{:else if done && !error}
		<div class="flex items-center gap-3 text-success">
			<CheckCircle class="w-5 h-5" />
			<span class="font-medium">go2rtc + ONVIF Server erfolgreich konfiguriert</span>
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

	{#if done && !loading && !error}
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
