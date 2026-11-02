<script lang="ts">
	import { Loader2, CheckCircle, AlertTriangle, ExternalLink } from 'lucide-svelte';

	let {
		cameraId,
		cameraName,
		containerIp,
		cameraIp,
		isNativeOnvif = false,
		onClose
	}: {
		cameraId: number;
		cameraName: string;
		containerIp: string | null;
		cameraIp?: string;
		isNativeOnvif?: boolean;
		onClose: () => void;
	} = $props();

	let targetIp = $derived(isNativeOnvif ? cameraIp : containerIp);

	let loading = $state(true);
	let result = $state<{
		onvifRunning: boolean;
		containerReachable: boolean;
		instructions: string[];
		protectUrl: string;
	} | null>(null);
	let error = $state<string | null>(null);

	async function checkAdoption() {
		loading = true;
		error = null;
		result = null;
		try {
			const res = await fetch('/api/protect/adopt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cameraId })
			});
			if (res.ok) {
				result = await res.json();
			} else {
				const data = await res.json().catch(() => ({}));
				error = data.error || 'Fehler beim Prüfen des ONVIF-Servers';
			}
		} catch {
			error = 'Verbindung fehlgeschlagen';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		checkAdoption();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center"
	onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
	<div class="bg-bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6">
		<h3 class="text-text-primary font-bold text-base mb-1">
			Protect Adoption -- {cameraName}
		</h3>
		<p class="text-text-secondary text-xs mb-5">
			{targetIp ? `${isNativeOnvif ? 'Kamera' : 'Container'} IP: ${targetIp}` : 'Kamera wird geprüft...'}
		</p>

		{#if loading}
			<!-- Loading state -->
			<div class="flex items-center gap-3 text-text-secondary py-8 justify-center">
				<Loader2 class="w-5 h-5 animate-spin" />
				<span>ONVIF-Server wird geprüft...</span>
			</div>
		{:else if result && result.onvifRunning}
			<!-- Success state -->
			<div class="space-y-4">
				<div class="flex items-center gap-2 text-success">
					<CheckCircle class="w-5 h-5" />
					<span class="font-medium text-sm">ONVIF-Server läuft</span>
				</div>

				{#if result.instructions.length > 0}
					<div class="space-y-2">
						<p class="text-xs text-text-secondary font-medium uppercase tracking-wider">Schritte zur Adoption</p>
						{#each result.instructions as instruction, i}
							<div class="flex gap-3 bg-bg-primary/50 rounded-lg px-4 py-3">
								<span class="flex items-center justify-center w-6 h-6 rounded-full bg-accent/15 text-accent text-xs font-bold shrink-0">
									{i + 1}
								</span>
								<span class="text-sm text-text-primary">{instruction}</span>
							</div>
						{/each}
					</div>
				{/if}

				<div class="flex items-center gap-3 pt-2">
					<a
						href={result.protectUrl}
						target="_blank"
						class="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90"
					>
						<ExternalLink class="w-4 h-4" />
						UniFi Protect öffnen
					</a>
					<button
						onclick={onClose}
						class="px-4 py-2 text-sm bg-bg-input text-text-secondary rounded-lg hover:bg-bg-primary cursor-pointer"
					>
						Schließen
					</button>
				</div>
			</div>
		{:else}
			<!-- Error state -->
			<div class="space-y-4">
				<div class="flex items-center gap-2 text-danger">
					<AlertTriangle class="w-5 h-5" />
					<span class="font-medium text-sm">ONVIF-Server nicht erreichbar</span>
				</div>

				<p class="text-sm text-text-secondary">
					{#if error}
						{error}
					{:else}
						Der ONVIF-Server auf {containerIp || 'unbekannt'} antwortet nicht.
						Starte den Container neu und versuche es erneut.
					{/if}
				</p>

				<div class="flex items-center gap-3 pt-2">
					<button
						onclick={checkAdoption}
						class="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 cursor-pointer"
					>
						Erneut prüfen
					</button>
					<button
						onclick={onClose}
						class="px-4 py-2 text-sm bg-bg-input text-text-secondary rounded-lg hover:bg-bg-primary cursor-pointer"
					>
						Schließen
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
