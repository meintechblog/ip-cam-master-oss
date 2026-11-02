<script lang="ts">
	// v1.3 Phase 22 Plan 04 — Wizard Step 6 "Hub aktiv" (HUB-WIZ-08).
	//
	// Renders the confirmation card. Primary CTA "Zur Kameraliste" calls
	// POST /api/protect-hub/wizard/complete (atomic flag-flip + completePointer
	// per Plan 02), then `goto('/kameras?onboarding=success')`. The toast banner
	// is consumed once on /kameras mount (Plan 03 Pitfall #4).
	//
	// On 500: render error state + Retry button — the call is idempotent
	// (saveSetting upserts; completePointer upserts), so a retried success
	// is safe.
	import { CheckCircle2, XCircle, Loader2, ExternalLink } from 'lucide-svelte';
	import { goto } from '$app/navigation';

	type Summary = {
		camCount: number;
		loxoneCount: number;
		frigateCount: number;
	};

	let {
		summary
	}: {
		summary?: Summary;
	} = $props();

	let submitting = $state(false);
	let submitError = $state<string | null>(null);

	async function complete() {
		if (submitting) return;
		submitting = true;
		submitError = null;
		try {
			const res = await fetch('/api/protect-hub/wizard/complete', { method: 'POST' });
			const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (!res.ok || !body.ok) {
				submitError = body.error || 'Hub konnte nicht aktiviert werden.';
				return;
			}
			await goto('/kameras?onboarding=success');
		} catch (err) {
			submitError = err instanceof Error ? err.message : 'Netzwerkfehler';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="bg-bg-card rounded-lg border border-border p-6 space-y-4">
	<div class="flex items-start gap-3">
		<CheckCircle2 class="w-6 h-6 text-success shrink-0 mt-0.5" />
		<div>
			<h2 class="text-base font-semibold text-text-primary">Schritt 6: Hub aktiv</h2>
			<p class="text-sm text-text-secondary mt-1">
				Alle ausgewählten Kameras sind unter "Aus UniFi Protect" in /kameras sichtbar.
			</p>
		</div>
	</div>

	{#if summary}
		<div class="grid grid-cols-3 gap-3">
			<div class="bg-bg-input border border-border rounded-lg p-3">
				<p class="text-xs text-text-secondary">Kameras</p>
				<p class="text-base font-semibold text-text-primary">{summary.camCount}</p>
			</div>
			<div class="bg-bg-input border border-border rounded-lg p-3">
				<p class="text-xs text-text-secondary">Loxone-MJPEG</p>
				<p class="text-base font-semibold text-text-primary">{summary.loxoneCount}</p>
			</div>
			<div class="bg-bg-input border border-border rounded-lg p-3">
				<p class="text-xs text-text-secondary">Frigate-RTSP</p>
				<p class="text-base font-semibold text-text-primary">{summary.frigateCount}</p>
			</div>
		</div>
	{/if}

	{#if submitError}
		<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-3">
			<div class="flex items-center gap-2">
				<XCircle class="w-5 h-5 text-red-400 shrink-0" />
				<span class="text-sm font-medium text-red-400">{submitError}</span>
			</div>
			<button
				type="button"
				onclick={complete}
				class="inline-flex items-center gap-2 px-3 py-1.5 border border-border text-text-secondary
					rounded-lg hover:text-text-primary hover:bg-bg-input transition-colors text-sm cursor-pointer"
			>
				Erneut versuchen
			</button>
		</div>
	{/if}

	<div class="flex items-center justify-between gap-3 flex-wrap">
		<a
			href="/settings/protect-hub/all-urls"
			class="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 cursor-pointer"
		>
			<ExternalLink class="w-4 h-4" />
			Alle Adressen anzeigen
		</a>
		<button
			type="button"
			onclick={complete}
			disabled={submitting}
			class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
				hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer disabled:opacity-50"
		>
			{#if submitting}
				<Loader2 class="w-4 h-4 animate-spin" />
			{/if}
			Zur Kameraliste
		</button>
	</div>
</div>
