<script lang="ts">
	// v1.3 Phase 22 Plan 05 — Hub-Adressen Übersicht (HUB-UI-07).
	//
	// Renders all enabled output URLs grouped by output type. Loxone-MJPEG
	// first (the more common case for residential users wiring intercom
	// tiles), Frigate-RTSP second. Per row: cam name + slug + mono URL +
	// copy button (standard Shared 5 idiom).
	//
	// Empty page state when settings.protect_hub_enabled !== 'true': the
	// loader returns hubEnabled=false and we render the "Hub ist nicht
	// aktiv" copy with a deep-link back to the settings tab.
	//
	// Page h1 uses text-2xl font-semibold (NOT font-bold — UI-SPEC §typography
	// retired font-bold for P22-introduced h1 instances).
	import { ArrowLeft, Copy, Check } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const loxoneOutputs = $derived(data.outputs.filter((o) => o.outputType === 'loxone-mjpeg'));
	const frigateOutputs = $derived(data.outputs.filter((o) => o.outputType === 'frigate-rtsp'));

	let copiedKey = $state<string | null>(null);

	async function copyUrl(key: string, url: string) {
		if (await copyToClipboard(url)) {
			copiedKey = key;
			setTimeout(() => {
				if (copiedKey === key) copiedKey = null;
			}, 2000);
		}
	}
</script>

<div class="max-w-3xl">
	<a
		href="/settings"
		class="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 mb-6"
	>
		<ArrowLeft class="w-4 h-4" />
		Zurück zu Einstellungen
	</a>

	<h1 class="text-2xl font-semibold text-text-primary mb-2">Hub-Adressen — Übersicht</h1>
	<p class="text-sm text-text-secondary mb-8">
		Alle aktiven Stream-Adressen, gruppiert nach Ausgangstyp.
	</p>

	{#if !data.hubEnabled}
		<div class="bg-bg-card border border-border rounded-lg p-6">
			<p class="text-sm text-text-primary">
				Protect Hub ist nicht aktiv. <a
					href="/settings#protect-hub"
					class="text-accent hover:text-accent/80"
				>Im Einstellungs-Tab "Protect Hub" aktivieren.</a>
			</p>
		</div>
	{:else}
		<div class="space-y-8">
			<!-- Group 1: Loxone-MJPEG -->
			<section class="bg-bg-card border border-border rounded-lg p-6">
				<h2 class="text-base font-semibold text-text-primary mb-4">
					Loxone-MJPEG ({loxoneOutputs.length})
				</h2>
				{#if loxoneOutputs.length === 0}
					<p class="text-sm text-text-secondary">Keine Ausgänge dieses Typs aktiv.</p>
				{:else}
					<div class="divide-y divide-border">
						{#each loxoneOutputs as o (o.camId + '-' + o.outputType)}
							{@const key = `loxone-${o.camId}`}
							<div class="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-3">
								<div>
									<div class="text-sm text-text-primary">{o.camName}</div>
									<div class="text-xs font-mono text-text-secondary">{o.slug}</div>
								</div>
								<code class="text-xs font-mono text-text-primary truncate max-w-[24rem]"
									>{o.url}</code
								>
								<button
									type="button"
									onclick={() => copyUrl(key, o.url)}
									class="text-text-secondary hover:text-accent shrink-0 cursor-pointer p-1"
									title={copiedKey === key ? 'Kopiert' : 'Kopieren'}
								>
									<span class="sr-only">Adresse kopieren</span>
									{#if copiedKey === key}
										<Check class="w-4 h-4 text-success" />
									{:else}
										<Copy class="w-4 h-4" />
									{/if}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Group 2: Frigate-RTSP -->
			<section class="bg-bg-card border border-border rounded-lg p-6">
				<h2 class="text-base font-semibold text-text-primary mb-4">
					Frigate-RTSP ({frigateOutputs.length})
				</h2>
				{#if frigateOutputs.length === 0}
					<p class="text-sm text-text-secondary">Keine Ausgänge dieses Typs aktiv.</p>
				{:else}
					<div class="divide-y divide-border">
						{#each frigateOutputs as o (o.camId + '-' + o.outputType)}
							{@const key = `frigate-${o.camId}`}
							<div class="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-3">
								<div>
									<div class="text-sm text-text-primary">{o.camName}</div>
									<div class="text-xs font-mono text-text-secondary">{o.slug}</div>
								</div>
								<code class="text-xs font-mono text-text-primary truncate max-w-[24rem]"
									>{o.url}</code
								>
								<button
									type="button"
									onclick={() => copyUrl(key, o.url)}
									class="text-text-secondary hover:text-accent shrink-0 cursor-pointer p-1"
									title={copiedKey === key ? 'Kopiert' : 'Kopieren'}
								>
									<span class="sr-only">Adresse kopieren</span>
									{#if copiedKey === key}
										<Check class="w-4 h-4 text-success" />
									{:else}
										<Copy class="w-4 h-4" />
									{/if}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	{/if}
</div>
