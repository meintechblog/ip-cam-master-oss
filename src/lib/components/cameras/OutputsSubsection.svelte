<!--
  v1.3 Phase 22 Plan 03 Task 2 — "Bridge-Ausgänge" subsection.

  Composes two <OutputToggle> rows + URL caption rows + copy buttons. The URL
  rows render only when the toggle is ON (per UI-SPEC §outputs-subsection
  line 247: caption "Adresse:" + mono URL + copy button when enabled).

  Per the replace-strategy contract on PUT /api/cameras/{id}/outputs, every
  toggle press must include the FULL output set for the cam — this component
  composes `siblingOutputs` for each child by passing the OTHER row's current
  enabled state.
-->
<script lang="ts">
	import { Copy, Check } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { deriveStreamUrl, type OutputType } from '$lib/protect-hub/slug';
	import type { CameraOutputRow } from '$lib/types';
	import OutputToggle from './OutputToggle.svelte';

	let {
		cameraId,
		mac,
		bridgeIp,
		initialOutputs
	}: {
		cameraId: number;
		mac: string;
		bridgeIp: string | null;
		initialOutputs: CameraOutputRow[];
	} = $props();

	const initialMap = new Map(
		initialOutputs.map((o) => [o.outputType, o.enabled] as const)
	);

	let loxoneEnabled = $state(initialMap.get('loxone-mjpeg') ?? false);
	let frigateEnabled = $state(initialMap.get('frigate-rtsp') ?? false);

	const loxoneUrl = $derived(
		bridgeIp && mac ? deriveStreamUrl(bridgeIp, mac, 'loxone-mjpeg') : ''
	);
	const frigateUrl = $derived(
		bridgeIp && mac ? deriveStreamUrl(bridgeIp, mac, 'frigate-rtsp') : ''
	);

	let copiedLoxone = $state(false);
	let copiedFrigate = $state(false);

	async function copyLoxone() {
		if (!loxoneUrl) return;
		if (await copyToClipboard(loxoneUrl)) {
			copiedLoxone = true;
			setTimeout(() => (copiedLoxone = false), 2000);
		}
	}
	async function copyFrigate() {
		if (!frigateUrl) return;
		if (await copyToClipboard(frigateUrl)) {
			copiedFrigate = true;
			setTimeout(() => (copiedFrigate = false), 2000);
		}
	}

	// Build sibling-output arrays so the replace-strategy PUT keeps the OTHER
	// output's current state intact when toggling this one.
	const loxoneSiblings = $derived<{ outputType: OutputType; enabled: boolean }[]>(
		frigateEnabled ? [{ outputType: 'frigate-rtsp', enabled: true }] : []
	);
	const frigateSiblings = $derived<{ outputType: OutputType; enabled: boolean }[]>(
		loxoneEnabled ? [{ outputType: 'loxone-mjpeg', enabled: true }] : []
	);
</script>

<div class="mt-6">
	<h3 class="text-base font-semibold text-text-primary mb-4">Bridge-Ausgänge</h3>

	<div class="space-y-4">
		<!-- Loxone-MJPEG row -->
		<div class="bg-bg-input rounded-lg p-4">
			<div class="flex items-center gap-4">
				<div class="flex-1">
					<div class="text-sm text-text-primary">Loxone-MJPEG</div>
					<div class="text-xs text-text-secondary">640×360 · 10 fps · transcodiert (VAAPI)</div>
				</div>
				<OutputToggle
					{cameraId}
					outputType="loxone-mjpeg"
					bind:enabled={loxoneEnabled}
					siblingOutputs={loxoneSiblings}
				/>
			</div>
			{#if loxoneEnabled && loxoneUrl}
				<div class="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2 mt-3">
					<span class="text-xs text-text-secondary shrink-0">Adresse:</span>
					<code class="text-xs text-text-primary font-mono flex-1 truncate">{loxoneUrl}</code>
					<button
						onclick={copyLoxone}
						type="button"
						class="text-text-secondary hover:text-accent shrink-0 cursor-pointer p-1"
						title={copiedLoxone ? 'Kopiert' : 'Kopieren'}
					>
						{#if copiedLoxone}
							<Check class="w-4 h-4 text-green-400" />
						{:else}
							<Copy class="w-4 h-4" />
						{/if}
						<span class="sr-only">Adresse kopieren</span>
					</button>
				</div>
			{/if}
		</div>

		<!-- Frigate-RTSP row -->
		<div class="bg-bg-input rounded-lg p-4">
			<div class="flex items-center gap-4">
				<div class="flex-1">
					<div class="text-sm text-text-primary">Frigate-RTSP</div>
					<div class="text-xs text-text-secondary">Passthrough · ohne Audio</div>
				</div>
				<OutputToggle
					{cameraId}
					outputType="frigate-rtsp"
					bind:enabled={frigateEnabled}
					siblingOutputs={frigateSiblings}
				/>
			</div>
			{#if frigateEnabled && frigateUrl}
				<div class="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2 mt-3">
					<span class="text-xs text-text-secondary shrink-0">Adresse:</span>
					<code class="text-xs text-text-primary font-mono flex-1 truncate">{frigateUrl}</code>
					<button
						onclick={copyFrigate}
						type="button"
						class="text-text-secondary hover:text-accent shrink-0 cursor-pointer p-1"
						title={copiedFrigate ? 'Kopiert' : 'Kopieren'}
					>
						{#if copiedFrigate}
							<Check class="w-4 h-4 text-green-400" />
						{:else}
							<Copy class="w-4 h-4" />
						{/if}
						<span class="sr-only">Adresse kopieren</span>
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>
