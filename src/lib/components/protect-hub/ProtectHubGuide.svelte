<!--
  v1.3 Phase 22 Plan 03 Task 3 — Protect-Hub stream-embedding guide (HUB-UI-04, HUB-UI-05).

  Tabbed snippet display rendered under the Outputs subsection on every
  external cam card. Two tabs: Loxone (Intercom) + Frigate (NVR). Each tab
  shows a ready-to-paste snippet pre-filled with the bridge IP + the cam's
  go2rtc slug (derived via the shared $lib/protect-hub/slug util — keeps
  byte-identical with the YAML key the bridge actually serves, per Pitfall #9).

  Loxone snippet: 3 lines of plain text with German `#`-comments — drops into
  the "Benutzerdefinierte Intercom" config field verbatim.

  Frigate snippet: per-cam YAML block with commented detect/record hints —
  drops into Frigate's `cameras:` block in config.yml verbatim.

  Short-circuits to nothing when bridgeIp or mac is null (the user has not
  yet provisioned a bridge or the cam row lacks a MAC).

  Copy buttons reuse the standard $lib/utils/clipboard idiom + 2s success-flash.
-->
<script lang="ts">
	import { Copy, Check } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	// v1.3 Phase 22 CR-04 fix — use the shared deriveSlug() so the snippets
	// stay byte-identical with the YAML key the bridge actually serves
	// (Pitfall #9). The previous implementation hardcoded `${mac}-low` /
	// `${mac}-high` which silently diverges if D-PIPE-06 changes the suffix
	// mapping.
	import { deriveSlug } from '$lib/protect-hub/slug';

	let {
		bridgeIp,
		mac,
		camName: _camName
	}: { bridgeIp: string | null; mac: string; camName: string } = $props();
	// camName accepted for future use (e.g. snippet-header title); not currently
	// rendered — keeping in props so callers don't need to refactor when copy is
	// extended in P23 (e.g. "Snippet for {camName}").

	let activeTab = $state<'loxone' | 'frigate'>('loxone');
	let copiedLoxone = $state(false);
	let copiedFrigate = $state(false);

	const loxoneSlug = $derived(mac ? deriveSlug(mac, 'loxone-mjpeg') : '');
	const frigateSlug = $derived(mac ? deriveSlug(mac, 'frigate-rtsp') : '');

	const loxoneSnippet = $derived(
		bridgeIp && mac
			? `# Adresse: MJPEG-Stream über Hub-Bridge\nURL: http://${bridgeIp}:1984/api/stream.mjpeg?src=${loxoneSlug}\n# Hinweis: User-Agent darf leer bleiben. Auth nicht aktiv (LAN-Trust).`
			: ''
	);

	const frigateSnippet = $derived(
		bridgeIp && mac
			? `cameras:\n  ${frigateSlug}:\n    ffmpeg:\n      inputs:\n        - path: rtsp://${bridgeIp}:8554/${frigateSlug}\n          roles:\n            - record\n            # - detect   # auskommentiert: Erkennung kostet CPU\n    # detect:\n    #   width: 1280\n    #   height: 720\n    #   fps: 5\n    # record:\n    #   enabled: true\n    #   retain:\n    #     days: 7\n    #     mode: motion`
			: ''
	);

	async function copyLoxone() {
		if (await copyToClipboard(loxoneSnippet)) {
			copiedLoxone = true;
			setTimeout(() => {
				copiedLoxone = false;
			}, 2000);
		}
	}
	async function copyFrigate() {
		if (await copyToClipboard(frigateSnippet)) {
			copiedFrigate = true;
			setTimeout(() => {
				copiedFrigate = false;
			}, 2000);
		}
	}
</script>

{#if bridgeIp && mac}
	<div class="mt-6 bg-bg-card rounded-lg border border-border p-6">
		<h3 class="text-base font-semibold text-text-primary mb-4">Anleitung — Stream einbinden</h3>

		<!-- Tabs -->
		<div class="flex gap-2 mb-4 border-b border-border">
			<button
				onclick={() => (activeTab = 'loxone')}
				class="px-3 py-2 text-sm cursor-pointer {activeTab === 'loxone'
					? 'text-accent border-b-2 border-accent'
					: 'text-text-secondary hover:text-text-primary'}"
				type="button"
			>
				Loxone (Intercom)
			</button>
			<button
				onclick={() => (activeTab = 'frigate')}
				class="px-3 py-2 text-sm cursor-pointer {activeTab === 'frigate'
					? 'text-accent border-b-2 border-accent'
					: 'text-text-secondary hover:text-text-primary'}"
				type="button"
			>
				Frigate (NVR)
			</button>
		</div>

		{#if activeTab === 'loxone'}
			<div class="flex items-center justify-between mb-2">
				<h4 class="text-sm font-semibold text-text-primary">
					Benutzerdefinierte Intercom — Konfiguration
				</h4>
				<button
					onclick={copyLoxone}
					class="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent cursor-pointer"
					type="button"
					title={copiedLoxone ? 'Kopiert' : 'Snippet kopieren'}
				>
					{#if copiedLoxone}
						<Check class="w-4 h-4 text-green-400" />
						<span class="text-success">Kopiert</span>
					{:else}
						<Copy class="w-4 h-4" />
						<span>Snippet kopieren</span>
					{/if}
					<span class="sr-only">Snippet kopieren</span>
				</button>
			</div>
			<pre
				class="text-xs font-mono leading-relaxed bg-bg-input rounded-lg p-4 overflow-x-auto text-text-primary"
				aria-label="Snippet"><code>{loxoneSnippet}</code></pre>
		{:else}
			<div class="flex items-center justify-between mb-2">
				<h4 class="text-sm font-semibold text-text-primary">cameras: Block für config.yml</h4>
				<button
					onclick={copyFrigate}
					class="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent cursor-pointer"
					type="button"
					title={copiedFrigate ? 'Kopiert' : 'Snippet kopieren'}
				>
					{#if copiedFrigate}
						<Check class="w-4 h-4 text-green-400" />
						<span class="text-success">Kopiert</span>
					{:else}
						<Copy class="w-4 h-4" />
						<span>Snippet kopieren</span>
					{/if}
					<span class="sr-only">Snippet kopieren</span>
				</button>
			</div>
			<pre
				class="text-xs font-mono leading-relaxed bg-bg-input rounded-lg p-4 overflow-x-auto text-text-primary"
				aria-label="Snippet"><code>{frigateSnippet}</code></pre>
		{/if}
	</div>
{/if}
